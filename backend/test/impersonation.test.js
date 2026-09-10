import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * A plataforma entrando no painel de um ISP — o acesso mais perigoso do produto.
 *
 * Entrar no painel de um provedor é alcançar o cadastro inteiro de assinantes
 * dele. É indispensável para suporte e é exatamente o que não pode acontecer
 * sem registro. Abuso aqui não se previne: se limita e se mostra. O que este
 * arquivo persegue são as quatro limitações e a mostra.
 *
 * O caso que vale por si é o da **escalada em círculo**: sem a recusa em
 * `requirePlatformAdmin`, quem entrasse no painel de um ISP para dar suporte
 * poderia, de dentro dele, criar provedor ou suspender vizinho — e a trilha
 * atribuiria isso a uma sessão que existe para ser só de leitura.
 */

process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.exemplo.com';

const {
  authHeaders, call, getDb, insertReturningId, runInTenant,
  startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const { default: Subscription } = await import('../src/models/Subscription.js');
const { default: Plan } = await import('../src/models/Plan.js');
const { IMPERSONATION_CODES } = await import('../src/config/impersonation.js');

/**
 * Requisição com `Host` escolhido — `fetch` não serve: `Host` é header proibido
 * lá e o undici o substitui em silêncio, de modo que o caso do host do vizinho
 * passaria provando nada.
 */
function callAs(host, url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method,
      headers: {
        Host: host,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers
      }
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: response.statusCode, body: parsed });
      });
    });
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

const ALFA_HOST = 'alfa.painel.exemplo.com';
const BETA_HOST = 'beta.painel.exemplo.com';

let panelUrl;
let alfa;
let beta;
let daPlataforma;
let plataformaId;
let doProvedor;

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  await getDb()('tenants').where({ id: alfa }).update({ slug: 'alfa' });
  beta = await insertReturningId('tenants', {
    slug: 'beta', name: 'Provedor Beta', status: 'active'
  });
  // A linha inserida à mão não passa pelo seed, então o beta nasceria sem
  // assinatura — e a porta comercial responderia 402 antes de qualquer coisa
  // aqui, fazendo os casos de leitura passarem sem provar nada.
  const plano = await Plan.findByCode('unlimited');
  await Subscription.upsertForTenant(beta, { status: 'active', plan_id: plano.id });

  const setup = await callAs(ALFA_HOST, `${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'suporte', password: 'senha-do-suporte-1', email: 'suporte@nos.test' }
  });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  daPlataforma = setup.body.data.token;
  plataformaId = setup.body.data.user.id;
  // O setup do SaaS já pode ter posto o primeiro administrador na lista.
  if (!(await getDb()('platform_admins').where({ user_id: plataformaId }).first())) {
    await getDb()('platform_admins').insert({ user_id: plataformaId });
  }

  // Um administrador do provedor, que NÃO é da plataforma.
  const contratado = await callAs(ALFA_HOST, `${panelUrl}/api/users`, {
    method: 'POST',
    headers: authHeaders(daPlataforma),
    body: {
      username: 'operador', password: 'senha-do-operador-1',
      email: 'operador@alfa.test', role: 'admin'
    }
  });
  assert.equal(contratado.status, 201, JSON.stringify(contratado.body));
  const entrou = await callAs(ALFA_HOST, `${panelUrl}/api/auth/login`, {
    method: 'POST', body: { username: 'operador', password: 'senha-do-operador-1' }
  });
  doProvedor = entrou.body.data.token;
});

after(async () => {
  await stopTestServers();
});

/** Emite uma sessão de impersonação no provedor pedido. */
const entrar = (tenantId, body = { reason: 'chamado 4412' }) => callAs(
  ALFA_HOST, `${panelUrl}/api/platform/tenants/${tenantId}/impersonate`,
  { method: 'POST', headers: authHeaders(daPlataforma), body }
);

/** Um token de impersonação no beta, pronto para usar. */
async function tokenNoBeta() {
  const { status, body } = await entrar(beta);
  assert.equal(status, 201, JSON.stringify(body));
  return body.data.token;
}

beforeEach(async () => {
  if (!(await getDb()('platform_admins').where({ user_id: plataformaId }).first())) {
    await getDb()('platform_admins').insert({ user_id: plataformaId });
  }
  await getDb()('tenants').where({ id: beta }).update({ status: 'active' });
});

describe('quem consegue entrar', () => {
  it('um administrador do provedor, que não é da plataforma, recebe 404', async () => {
    // 404 e não 403, pela mesma razão que o resto do console: um 403 confirma
    // que o plano de controle existe neste deploy.
    const { status } = await callAs(ALFA_HOST, `${panelUrl}/api/platform/tenants/${beta}/impersonate`, {
      method: 'POST', headers: authHeaders(doProvedor), body: { reason: 'quero ver' }
    });
    assert.equal(status, 404);
  });

  it('e sem sessão nenhuma, 401', async () => {
    const { status } = await callAs(ALFA_HOST, `${panelUrl}/api/platform/tenants/${beta}/impersonate`, {
      method: 'POST', body: { reason: 'quero ver' }
    });
    assert.equal(status, 401);
  });

  it('o motivo é obrigatório', async () => {
    // É o campo que transforma "a plataforma entrou" em algo que o ISP
    // consegue conferir contra o chamado que ele mesmo abriu.
    const { status } = await entrar(beta, { reason: '' });
    assert.equal(status, 400);
  });

  it('e num provedor suspenso não se entra', async () => {
    // Suspenso é o estado que a exclusão em duas etapas exige para significar
    // "ninguém está trabalhando lá dentro". Entrar contradiria isso.
    await getDb()('tenants').where({ id: beta }).update({ status: 'suspended' });
    const { status } = await entrar(beta);
    assert.equal(status, 409);
  });
});

describe('as duas trilhas, e o token só depois delas', () => {
  it('a trilha da plataforma registra que entramos', async () => {
    await entrar(beta, { reason: 'chamado 7781' });
    const linha = await getDb()('platform_audit')
      .where({ action: 'tenant.impersonation_started', tenant_id: beta })
      .orderBy('id', 'desc').first();
    assert.ok(linha, 'faltou a linha na trilha da plataforma');
    assert.match(String(linha.detail), /7781/);
  });

  it('e a do PROVEDOR também — é como o ISP descobre sozinho', async () => {
    // Uma trilha que só nós lemos não é auditoria, é confiança.
    await entrar(beta, { reason: 'chamado 9902' });
    const linha = await runInTenant(beta, () => getDb()('audit_log')
      .where({ tenant_id: beta, action: 'impersonation.started' })
      .orderBy('id', 'desc').first());
    assert.ok(linha, 'o ISP não teria como saber que entramos');
    assert.match(String(linha.detail), /9902/);
    assert.equal(linha.actor_username, 'suporte', 'a linha tem que nomear quem entrou');
  });

  it('sem registro, não se entra', async () => {
    // A ordem é a mesma da exclusão de provedor: a trilha vem antes, e o
    // retorno é conferido. Escrever depois deixa a janela em que o acesso já
    // foi concedido e o registro falhou.
    const original = AuditLog.fromRequest;
    AuditLog.fromRequest = async () => false;
    try {
      const { status, body } = await entrar(beta);
      assert.equal(status, 503, JSON.stringify(body));
      assert.equal(body.data?.token, undefined);
    } finally {
      AuditLog.fromRequest = original;
    }
  });
});

describe('o que a sessão alcança', () => {
  it('lê o que o papel dá — o mapa do provedor', async () => {
    // `map.read`, que o `viewer` tem, e que não depende do GenieACS: a lista de
    // aparelhos responderia 500 num provedor sem ACS configurado e o caso
    // falaria de infraestrutura em vez de autorização.
    const token = await tokenNoBeta();
    const { status, body } = await callAs(BETA_HOST, `${panelUrl}/api/map-settings`, {
      headers: authHeaders(token)
    });
    // 200 exato, e não "diferente de 401": um `notEqual` aceitaria o 402 da
    // porta comercial e o caso passaria provando nada — foi o que aconteceu na
    // primeira escrita deste arquivo.
    assert.equal(status, 200, JSON.stringify(body));
  });

  it('mas não escreve nada', async () => {
    const token = await tokenNoBeta();
    const { status, body } = await callAs(BETA_HOST, `${panelUrl}/api/map-settings`, {
      method: 'PUT', headers: authHeaders(token),
      body: { centerLat: -23.5, centerLng: -46.6, zoom: 12 }
    });
    assert.equal(status, 403);
    assert.equal(body.code, IMPERSONATION_CODES.READ_ONLY);
  });

  it('e não alcança a senha de portal de um assinante', async () => {
    // É `GET`, então "só leitura" não a barraria: o que a barra é o papel.
    // Ler a credencial do cliente do nosso cliente não é suporte.
    const token = await tokenNoBeta();
    const { status } = await callAs(BETA_HOST, `${panelUrl}/api/devices/qualquer/portal-password`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 403);
  });

  it('nem o plano de controle — a escalada em círculo', async () => {
    // Sem esta recusa, quem entrou para dar suporte criaria provedor ou
    // suspenderia vizinho de dentro de uma sessão feita para só ler.
    const token = await tokenNoBeta();
    const { status, body } = await callAs(BETA_HOST, `${panelUrl}/api/platform/tenants`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 403);
    assert.equal(body.code, IMPERSONATION_CODES.NO_CONTROL_PLANE);
  });

  it('e não emite outra impersonação a partir de si mesma', async () => {
    // Duas regras barram esta, e a ordem importa para o teste não mentir: a de
    // só-leitura roda na autenticação e pega o POST antes de a rota existir,
    // então é ELA que responde aqui. A recusa do plano de controle é provada
    // pelo caso acima, que é um GET e chega até a guarda.
    const token = await tokenNoBeta();
    const { status, body } = await callAs(BETA_HOST, `${panelUrl}/api/platform/tenants/${alfa}/impersonate`, {
      method: 'POST', headers: authHeaders(token), body: { reason: 'de novo' }
    });
    assert.equal(status, 403);
    assert.equal(body.code, IMPERSONATION_CODES.READ_ONLY);
  });
});

describe('o token não sobrevive ao que o autorizou', () => {
  it('tirar a pessoa do plano de controle derruba a sessão na hora', async () => {
    // O token diz quem entrou; quem autoriza é a tabela. Esperar os quinze
    // minutos seria esperar justamente quando o motivo de tirar a pessoa da
    // lista pode ser o que ela está fazendo agora.
    const token = await tokenNoBeta();
    const antes = await callAs(BETA_HOST, `${panelUrl}/api/map-settings`, { headers: authHeaders(token) });
    assert.equal(antes.status, 200, 'o caso precisa começar de uma sessão que funciona');

    await getDb()('platform_admins').where({ user_id: plataformaId }).delete();
    const depois = await callAs(BETA_HOST, `${panelUrl}/api/map-settings`, { headers: authHeaders(token) });
    assert.equal(depois.status, 403);
  });

  it('e o token do beta não vale no host do alfa', async () => {
    const token = await tokenNoBeta();
    const { status, body } = await callAs(ALFA_HOST, `${panelUrl}/api/map-settings`, {
      headers: authHeaders(token)
    });
    assert.equal(status, 403);
    assert.equal(body.code, 'tenant_mismatch');
  });
});

describe('as duas audiências não se cruzam', () => {
  it('uma sessão comum não é lida como impersonação', async () => {
    // Se fosse, um operador qualquer viraria sessão de suporte — e, pior, o
    // contrário: a impersonação passaria a escrever.
    const { status } = await callAs(ALFA_HOST, `${panelUrl}/api/map-settings`, {
      method: 'PUT', headers: authHeaders(daPlataforma),
      body: { centerLat: -23.5, centerLng: -46.6, zoom: 12 }
    });
    assert.notEqual(status, 403, 'a sessão comum foi barrada como se fosse impersonação');
  });

  it('e a impersonação não é lida como sessão comum', async () => {
    const token = await tokenNoBeta();
    // A rota de renovação só aceita refresh token de audiência comum; um token
    // de impersonação não pode virar sessão durável por ela.
    const { status } = await callAs(BETA_HOST, `${panelUrl}/api/auth/refresh`, {
      method: 'POST', body: { refreshToken: token }
    });
    assert.notEqual(status, 200, 'a impersonação virou sessão renovável');
  });

  it('e a emissão não devolve refresh token nenhum', async () => {
    // A ausência é a decisão: com um, "o suporte entrou um instante" vira uma
    // semana.
    const { body } = await entrar(beta);
    assert.equal(body.data.refreshToken, undefined);
    assert.equal(body.data.readOnly, true);
  });
});

describe('o que a sessão faz fica marcado como dela', () => {
  it('a trilha do provedor distingue impersonação de operador', async () => {
    const token = await tokenNoBeta();
    await runInTenant(beta, () => AuditLog.fromRequest(
      { user: { userId: null, username: 'suporte', impersonation: { byUserId: plataformaId } }, ip: '127.0.0.1' },
      { action: AuditLog.ACTIONS.PORTAL_PASSWORD_REVEALED, subjectType: 'device', subjectId: 'x' }
    ));
    const linha = await runInTenant(beta, () => getDb()('audit_log')
      .where({ tenant_id: beta, action: 'portal_password.revealed' })
      .orderBy('id', 'desc').first());
    assert.ok(linha);
    assert.equal(linha.actor_kind, 'impersonation', 'uma ação de suporte pareceu ação do operador');
    assert.ok(token);
  });
});
