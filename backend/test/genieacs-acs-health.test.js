import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

/**
 * O GenieACS de um provedor fora do ar: uma linha curta no log, um aviso no
 * painel e a saúde no console.
 *
 * Em produção, um provedor com o DNS do ACS quebrado (`acs-inove.tr69.com.br
 * did not resolve`) enchia o journal: cada leitura — lista, painel, sonda de
 * RX, prewarm — escrevia um stack trace inteiro, várias vezes por minuto, e o
 * operador do provedor via só "falha ao carregar". Aqui se prova o contrário:
 * a falha vira um de oito códigos, sai UMA linha a cada 5 min por provedor e
 * código (sem host, sem mensagem), a rota responde `acs_unreachable` com a
 * frase traduzida, e a saúde de um provedor não aparece para o outro.
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, defaultTenantId, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { default: GenieAcsEgress, EGRESS_REFUSED } = await import('../src/services/genieacsEgress.js');
const { forgetSharedAcs } = await import('../src/services/genieacs/direct.js');
const { TranslatableError } = await import('../src/i18n/index.js');
const { AgentOfflineError } = await import('../src/services/genieacs/agentHub.js');
const {
  ACS_FAILURE_CODES, GENIEACS_DNS_FAILED, acsFailureOf, classifyAcsFailure, getAcsHealth, logUnlessAcsFailure,
  noteAcsResponse, recordAcsFailure, recordAcsSuccess, resetAcsHealth
} = await import('../src/services/genieacs/acsHealth.js');

const HOST_QUEBRADO = 'acs-inove.tr69.invalid';
const URL_QUEBRADA = `http://${HOST_QUEBRADO}:7557`;

/** Uma porta do loopback em que ninguém escuta. */
async function portaFechada() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('a classificação da falha do ACS', () => {
  it('o "não resolveu" do egresso é `dns`, pelo código posto onde ele é lançado', async () => {
    const lookupReal = GenieAcsEgress.lookup;
    GenieAcsEgress.lookup = async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); };
    try {
      const erro = await GenieAcsEgress.resolveTarget(URL_QUEBRADA).catch((error) => error);
      assert.match(erro.message, /did not resolve to any address/);
      assert.equal(erro.code, GENIEACS_DNS_FAILED);
      assert.equal(classifyAcsFailure(erro), 'dns');
    } finally {
      GenieAcsEgress.lookup = lookupReal;
    }
  });

  it('a recusa da guarda de egresso é `blocked`', async () => {
    const erro = await GenieAcsEgress.resolveTarget('ftp://acs.exemplo/').catch((error) => error);
    assert.equal(erro.code, EGRESS_REFUSED);
    assert.equal(classifyAcsFailure(erro), 'blocked');
  });

  it('a porta fechada, de verdade, pelo egresso, é `refused`', async () => {
    const port = await portaFechada();
    // A SaaS só deixa as portas da lista; esta é sorteada pelo sistema.
    const portasReais = GenieAcsEgress.ALLOWED_PORTS;
    GenieAcsEgress.ALLOWED_PORTS = new Set([port]);
    const erro = await GenieAcsEgress.fetch(`http://127.0.0.1:${port}/devices`, { allowPrivateAddresses: true })
      .catch((error) => error)
      .finally(() => { GenieAcsEgress.ALLOWED_PORTS = portasReais; });
    assert.ok(erro instanceof Error);
    assert.equal(erro.acsFailure, 'refused');
    assert.equal(classifyAcsFailure(erro), 'refused');
  });

  it('cada código de transporte cai no seu', () => {
    const casos = [
      [{ code: 'ENOTFOUND' }, 'dns'],
      [{ code: 'EAI_AGAIN' }, 'dns'],
      [new Error('getaddrinfo ENOTFOUND acs.exemplo'), 'dns'],
      [{ code: 'ECONNREFUSED' }, 'refused'],
      [new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }), 'refused'],
      [{ code: 'ETIMEDOUT' }, 'timeout'],
      [new DOMException('This operation was aborted', 'AbortError'), 'timeout'],
      [new DOMException('The operation timed out', 'TimeoutError'), 'timeout'],
      [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'tls'],
      [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'tls'],
      [{ code: 'CERT_HAS_EXPIRED' }, 'tls'],
      [{ acsHttpStatus: 401 }, 'unauthorized'],
      [{ acsHttpStatus: 403 }, 'unauthorized'],
      [{ acsHttpStatus: 502 }, 'http_error'],
      [new Error('GenieACS API responded with status: 503'), 'http_error'],
      [{ code: EGRESS_REFUSED }, 'blocked'],
      [{ code: 'ECONNRESET' }, 'unknown'],
      [{ acsFailure: 'unknown' }, 'unknown']
    ];
    for (const [erro, esperado] of casos) {
      assert.equal(classifyAcsFailure(erro), esperado, JSON.stringify(erro) || String(erro));
    }
    const vistos = new Set(casos.map(([, codigo]) => codigo));
    assert.deepEqual([...vistos].sort(), [...ACS_FAILURE_CODES].sort());
  });

  it('o 401/403/5xx que `genieAcsError` monta leva o status, e é classificado sem ler a frase', async () => {
    for (const [status, esperado] of [[401, 'unauthorized'], [403, 'unauthorized'], [500, 'http_error'], [404, null]]) {
      const erro = await DeviceService.genieAcsError('GenieACS API', new Response('', { status }));
      assert.equal(erro.acsHttpStatus, status);
      assert.equal(classifyAcsFailure(erro), esperado, String(status));
    }
  });

  it('o que não é falha do ACS fica de fora — e é o que mantém o stack', () => {
    assert.equal(classifyAcsFailure(new TypeError('Cannot read properties of undefined')), null);
    assert.equal(classifyAcsFailure(new TranslatableError('device.notFound', null, { status: 404 })), null);
    assert.equal(classifyAcsFailure(new AgentOfflineError(null)), null);
    assert.equal(classifyAcsFailure(new Error('GenieACS API responded with status: 404')), null);
    assert.equal(classifyAcsFailure(null), null);
  });

  it('longe do conector, só conta o erro marcado na origem: o ECONNREFUSED do SGP não é o ACS', () => {
    assert.equal(acsFailureOf(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })), null);
    assert.equal(acsFailureOf(new Error('Knex: Timeout acquiring a connection')), null);
    assert.equal(acsFailureOf({ acsFailure: 'refused' }), 'refused');
    assert.equal(acsFailureOf(new Error('wrap', { cause: { acsHttpStatus: 403 } })), 'unauthorized');
    assert.equal(acsFailureOf({ acsHttpStatus: 404 }), null);
  });
});

describe('o log da queda: uma linha a cada 5 min por provedor e código', () => {
  let agora;
  let linhas;

  beforeEach(() => {
    agora = Date.parse('2026-11-18T09:46:00Z');
    linhas = [];
    resetAcsHealth({ now: () => agora, log: (linha) => linhas.push(linha) });
  });

  afterEach(() => resetAcsHealth());

  it('duas falhas em 5 min dão uma linha; a volta dá outra', () => {
    recordAcsFailure(2, 'k', 'dns');
    agora += 60_000;
    recordAcsFailure(2, 'k', 'dns');
    assert.deepEqual(linhas, ['[tenant=2] GenieACS unreachable (dns); further failures suppressed for 5 min']);

    agora += 30_000;
    recordAcsSuccess(2, 'k');
    assert.deepEqual(linhas.slice(1), ['[tenant=2] GenieACS reachable again']);
    // Sucesso de quem já está bem não escreve nada.
    recordAcsSuccess(2, 'k');
    assert.equal(linhas.length, 2);
  });

  it('passados os 5 min, a queda que continua é lembrada', () => {
    recordAcsFailure(2, 'k', 'timeout');
    agora += 5 * 60_000 - 1;
    recordAcsFailure(2, 'k', 'timeout');
    assert.equal(linhas.length, 1);
    agora += 1;
    recordAcsFailure(2, 'k', 'timeout');
    assert.equal(linhas.length, 2);
  });

  it('a conta é por provedor e por código', () => {
    recordAcsFailure(2, 'k', 'dns');
    recordAcsFailure(3, 'k', 'dns');
    recordAcsFailure(2, 'k', 'refused');
    assert.deepEqual(linhas, [
      '[tenant=2] GenieACS unreachable (dns); further failures suppressed for 5 min',
      '[tenant=3] GenieACS unreachable (dns); further failures suppressed for 5 min',
      '[tenant=2] GenieACS unreachable (refused); further failures suppressed for 5 min'
    ]);
  });

  it('o estado: desde quando, quantas seguidas, e a troca de endereço começa do zero', () => {
    recordAcsFailure(2, 'a', 'dns');
    agora += 90_000;
    recordAcsFailure(2, 'a', 'dns');
    const saude = getAcsHealth(2);
    assert.equal(saude.status, 'down');
    assert.equal(saude.code, 'dns');
    assert.equal(saude.since, '2026-11-18T09:46:00.000Z');
    assert.equal(saude.lastCheckedAt, '2026-11-18T09:47:30.000Z');
    assert.equal(saude.consecutiveFailures, 2);
    assert.equal(saude.downForMs, 90_000);

    // O provedor trocou a URL: a queda do endereço antigo não diz nada do novo.
    noteAcsResponse(2, 'b', 200);
    assert.equal(getAcsHealth(2).status, 'ok');
    assert.equal(getAcsHealth(2).consecutiveFailures, 0);
    assert.equal(getAcsHealth(3).lastCheckedAt, null, 'quem nunca falou com o ACS não tem queda nenhuma');
  });

  it('401/403 e 5xx da NBI contam como queda; 404 é o ACS respondendo', () => {
    noteAcsResponse(2, 'k', 401);
    assert.equal(getAcsHealth(2).code, 'unauthorized');
    noteAcsResponse(2, 'k', 404);
    assert.equal(getAcsHealth(2).status, 'ok');
    noteAcsResponse(2, 'k', 503);
    assert.equal(getAcsHealth(2).code, 'http_error');
  });

  it('quem chamou e recebeu a falha do ACS não escreve nada; o bug nosso sai com stack', () => {
    const escritas = [];
    const original = console.error;
    console.error = (...args) => escritas.push(args);
    try {
      assert.equal(logUnlessAcsFailure('Get dashboard error', Object.assign(new Error('x'), { acsFailure: 'dns' })), 'dns');
      assert.equal(escritas.length, 0);
      const bug = new TypeError('boom');
      assert.equal(logUnlessAcsFailure('Get dashboard error', bug), null);
      assert.equal(escritas.length, 1);
      assert.equal(escritas[0].length, 1, 'uma linha só');
      assert.match(escritas[0][0], /^Get dashboard error: TypeError: boom \| +at /, 'o stack inteiro, numa linha');
      // Quebra de linha no texto do erro não forja uma linha nova no log.
      escritas.length = 0;
      logUnlessAcsFailure('Get dashboard error', new Error('a\nERROR forjada'), { messageOnly: true });
      assert.deepEqual(escritas, [['Get dashboard error: a | ERROR forjada']]);
    } finally {
      console.error = original;
    }
  });
});

describe('pelo painel e pelo console', () => {
  const OWNER = { username: 'dono', password: 'dono-senha-123', email: 'dono@exemplo.test' };
  let panelUrl;
  let genie;
  let token;
  let alfa;
  let beta;
  let lookupReal;
  let egressoReal;
  let escritas;
  const consoleReal = { error: console.error, warn: console.warn, log: console.log };

  const api = (path, options = {}) => call(`${panelUrl}/api${path}`, {
    ...options,
    headers: { ...authHeaders(token), ...(options.headers || {}) }
  });

  const capturar = () => {
    escritas = [];
    for (const nivel of ['error', 'warn']) {
      console[nivel] = (...args) => escritas.push(args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '));
    }
  };
  const soltar = () => {
    console.error = consoleReal.error;
    console.warn = consoleReal.warn;
  };

  before(async () => {
    ({ panelUrl } = await startTestServers());
    genie = await startGenieAcsStub();
    alfa = await defaultTenantId();
    const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: OWNER });
    assert.equal(setup.status, 201);
    token = setup.body.data.token;
    const userId = setup.body.data.user.id;
    if (!(await getDb()('platform_admins').where({ user_id: userId }).first())) {
      await getDb()('platform_admins').insert({ user_id: userId });
    }
    const criado = await api('/platform/tenants', { method: 'POST', body: { slug: 'beta', name: 'Beta' } });
    assert.equal(criado.status, 201);
    beta = criado.body.data.tenant.id;

    // O nome quebrado não resolve — sem ir à rede para descobrir. O ACS de
    // mentira mora no loopback, que a guarda da SaaS recusa com razão: só ele
    // vai direto; o resto passa pelo egresso de verdade.
    lookupReal = GenieAcsEgress.lookup;
    GenieAcsEgress.lookup = async (name) => {
      if (name === HOST_QUEBRADO) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      return lookupReal.call(GenieAcsEgress, name);
    };
    egressoReal = GenieAcsEgress.fetch;
    GenieAcsEgress.fetch = function fetchDeTeste(url, options) {
      if (String(url).startsWith(genie.url)) return fetch(url, options);
      return egressoReal.call(this, url, options);
    };
  });

  after(async () => {
    soltar();
    GenieAcsEgress.lookup = lookupReal;
    GenieAcsEgress.fetch = egressoReal;
    await genie.close();
    await stopTestServers();
  });

  beforeEach(async () => {
    resetAcsHealth();
    forgetSharedAcs();
    DeviceService.forgetDashboards();
    await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', URL_QUEBRADA));
    await runInTenant(beta, () => Setting.upsert('genieAcsUrl', `${genie.url}`));
  });

  afterEach(() => soltar());

  it('a lista e o painel respondem `acs_unreachable` (dns), traduzido, sem stack nem host no log', async () => {
    capturar();
    const lista = await api('/devices?pageSize=10', { headers: { 'Accept-Language': 'pt-BR' } });
    const painel = await api('/devices/dashboard?refresh=1', { headers: { 'Accept-Language': 'pt-BR' } });
    const falhas = await api('/devices/faults', { headers: { 'Accept-Language': 'en' } });
    // A atualização do painel em segundo plano termina depois da resposta.
    await new Promise((resolve) => setTimeout(resolve, 50));
    soltar();

    for (const { status, body } of [lista, painel, falhas]) {
      assert.equal(status, 502, JSON.stringify(body));
      assert.equal(body.code, 'acs_unreachable');
      assert.equal(body.reason, 'dns');
      assert.ok(!JSON.stringify(body).includes(HOST_QUEBRADO), 'o corpo não repete o host');
    }
    assert.equal(lista.body.message, 'O GenieACS não está acessível: o endereço configurado não existe no DNS.');
    assert.equal(falhas.body.message, 'GenieACS is unreachable: the configured address does not exist in DNS.');

    const doAcs = escritas.filter((linha) => linha.includes('GenieACS'));
    assert.deepEqual(
      doAcs.filter((linha) => linha.includes('unreachable')),
      [`[tenant=${alfa}] GenieACS unreachable (dns); further failures suppressed for 5 min`]
    );
    for (const linha of escritas) {
      assert.doesNotMatch(linha, /\n\s+at /, `stack trace no log: ${linha}`);
      assert.ok(!linha.includes(HOST_QUEBRADO), `host no log: ${linha}`);
    }
  });

  it('o prewarm e a sonda de RX também ficam quietos', async () => {
    capturar();
    await runInTenant(alfa, () => DeviceService.getDashboardData(false)).catch(() => null);
    await runInTenant(alfa, () => DeviceService.ensureRxPowerPaths()).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 50));
    soltar();
    for (const linha of escritas) {
      assert.doesNotMatch(linha, /\n\s+at /, `stack trace no log: ${linha}`);
      assert.ok(!linha.includes(HOST_QUEBRADO), `host no log: ${linha}`);
    }
    assert.ok(escritas.filter((linha) => linha.includes('unreachable (dns)')).length <= 1);
  });

  it('a saúde do provedor, para qualquer sessão dele, e a de um não aparece para o outro', async () => {
    // O beta fora, o alfa respondendo.
    await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', `${genie.url}`));
    await runInTenant(beta, () => Setting.upsert('genieAcsUrl', URL_QUEBRADA));
    forgetSharedAcs();
    capturar();
    await runInTenant(beta, () => DeviceService.fetchFromGenieAcs('')).catch(() => null);
    soltar();
    assert.ok(escritas.some((linha) => linha === `[tenant=${beta}] GenieACS unreachable (dns); further failures suppressed for 5 min`));

    const antes = await api('/devices/acs-health');
    assert.equal(antes.status, 200, JSON.stringify(antes.body));
    assert.equal(antes.body.data.status, 'ok');
    assert.equal(antes.body.data.lastCheckedAt, null, 'o alfa ainda não falou com o ACS dele');

    const lista = await api('/devices?pageSize=10');
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    const depois = await api('/devices/acs-health');
    assert.equal(depois.body.data.status, 'ok');
    assert.ok(depois.body.data.lastCheckedAt);

    assert.equal(getAcsHealth(beta).status, 'down');
    assert.equal(getAcsHealth(beta).code, 'dns');
  });

  it('o alfa fora aparece no endpoint dele, com o código e desde quando', async () => {
    await api('/devices?pageSize=10');
    const { status, body } = await api('/devices/acs-health');
    assert.equal(status, 200);
    assert.equal(body.data.status, 'down');
    assert.equal(body.data.code, 'dns');
    assert.ok(Date.parse(body.data.since) <= Date.now());
    assert.ok(body.data.consecutiveFailures >= 1);
    assert.equal(typeof body.data.downForMs, 'number');
    assert.ok(!JSON.stringify(body).includes(HOST_QUEBRADO));
  });

  it('a NBI que recusa a credencial vira `unauthorized`', async () => {
    await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', `${genie.url}`));
    genie.state.respond = ({ send }) => send(401, { error: 'unauthorized' });
    try {
      const lista = await api('/devices?pageSize=10');
      assert.equal(lista.status, 502);
      assert.equal(lista.body.code, 'acs_unreachable');
      assert.equal(lista.body.reason, 'unauthorized');
      const { body } = await api('/devices/acs-health');
      assert.equal(body.data.code, 'unauthorized');
    } finally {
      genie.state.respond = null;
    }
  });

  it('o console vê a saúde de cada provedor: na tela do GenieACS e na lista', async () => {
    await api('/devices?pageSize=10');
    await runInTenant(beta, () => DeviceService.fetchFromGenieAcs('')).catch(() => null);

    const doAlfa = await api(`/platform/tenants/${alfa}/genieacs`);
    assert.equal(doAlfa.status, 200, JSON.stringify(doAlfa.body));
    assert.equal(doAlfa.body.data.health.status, 'down');
    assert.equal(doAlfa.body.data.health.code, 'dns');

    const doBeta = await api(`/platform/tenants/${beta}/genieacs`);
    assert.equal(doBeta.body.data.health.status, 'ok');

    const lista = await api('/platform/tenants');
    assert.equal(lista.status, 200);
    const porId = new Map(lista.body.data.tenants.map((t) => [Number(t.id), t.acsHealth]));
    assert.equal(porId.get(Number(beta)).status, 'ok');
  });
});
