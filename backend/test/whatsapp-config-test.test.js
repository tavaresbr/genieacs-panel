import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { setProbeFetcher } = await import('../src/services/evolutionInstanceService.js');
const { whatsappTestLimiter } = await import('../src/middleware/rateLimit.js');

/**
 * O diagnóstico que roda com ZERO números conectados.
 *
 * A sonda por conta e a leitura do webhook no servidor já existem e já estão na
 * tela — mas todas por número conectado, e quem acabou de preencher a aba não
 * tem nenhum. Este arquivo cobre o teste de CONFIGURAÇÃO, e o que ele prova de
 * verdade é que cada passo afirma só o que sabe: passo bloqueado é `skipped`,
 * nunca ✗, porque dizer "a chave admin está errada" sobre um servidor que nem
 * respondeu é a forma de defeito que estes diagnósticos existem para acabar.
 */

const EVO_BASE = 'https://evo.provedor.test';
const ADMIN_KEY = 'chave-admin-do-servidor';
const WEBHOOK_OK = 'https://painel.provedor.test/api/whatsapp-webhook';

let panelUrl;
let token;
let userId;
let evoServer;
let evoLocalUrl;
let realFetch;

/** O que o servidor Evolution de mentira responde, por caso. */
const stub = {
  rootStatus: 200,
  rootBody: { version: '2.1.1', clientName: 'evolution' },
  serverOkStatus: 404,
  serverOkBody: { error: 'not found' },
  listStatus: 200,
  listBody: [{ name: 'instancia-existente', connectionStatus: 'open' }],
  adminKeyVisto: null
};

/** O que a volta responde, por caso. Substitui `safeFetch`, que barra loopback. */
const volta = {
  modo: 'painel',
  status: 200,
  corpo: '<!doctype html><html><body>SkyGenPanel</body></html>'
};

function startEvolutionStub() {
  evoServer = http.createServer((req, res) => {
    const responder = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const caminho = req.url.split('?')[0];
    if (caminho === '/') return responder(stub.rootStatus, stub.rootBody);
    if (caminho === '/server/ok') return responder(stub.serverOkStatus, stub.serverOkBody);
    if (caminho === '/instance/fetchInstances') {
      stub.adminKeyVisto = req.headers.apikey ?? null;
      return responder(stub.listStatus, stub.listBody);
    }
    return responder(404, { error: 'not found' });
  });
  return new Promise((resolve) => {
    evoServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${evoServer.address().port}`));
  });
}

/**
 * A volta, encanada.
 *
 * `safeFetch` recusa loopback e está certo — é o guarda que impede o campo do
 * webhook de virar um jeito de fazer o painel bater em endereço interno. O modo
 * `painel` refaz a chamada contra o painel de verdade, de ponta a ponta; os
 * outros montam a resposta que um destino ERRADO daria, que é o que não dá para
 * arranjar de outro jeito.
 */
function instalarVolta() {
  setProbeFetcher(async (url, options) => {
    if (volta.modo === 'painel') {
      const r = await realFetch(`${panelUrl}/api/whatsapp-webhook`, {
        method: options.method,
        headers: options.headers,
        body: options.body
      });
      return { status: r.status, text: () => r.text() };
    }
    if (volta.modo === 'transporte') throw new Error('getaddrinfo ENOTFOUND');
    return { status: volta.status, text: async () => volta.corpo };
  });
}

/** Configuração salva, do jeito que a aba WhatsApp grava. */
async function salvar(patch) {
  return asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true,
    webhookBaseUrl: WEBHOOK_OK,
    allowedHosts: 'evo.provedor.test',
    managedUrl: EVO_BASE,
    managedAdminKey: ADMIN_KEY,
    ...patch
  }));
}

const testar = () => call(`${panelUrl}/api/whatsapp/test`, {
  method: 'POST',
  headers: authHeaders(token)
});

/** O veredito de um passo, pelo nome. */
function veredito(body, passo) {
  const achado = body.data.passos.find((p) => p.passo === passo);
  assert.ok(achado, `o passo ${passo} não apareceu no resultado`);
  return achado.veredito;
}

const detalhe = (body, passo) => body.data.passos.find((p) => p.passo === passo)?.detalhe ?? null;

before(async () => {
  ({ panelUrl } = await startTestServers());
  evoLocalUrl = await startEvolutionStub();

  realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(EVO_BASE)) return realFetch(evoLocalUrl + url.slice(EVO_BASE.length), init);
    return realFetch(input, init);
  };
  instalarVolta();

  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  userId = setup.body.data.user.id;
});

after(async () => {
  globalThis.fetch = realFetch;
  setProbeFetcher(null);
  await new Promise((resolve) => evoServer.close(resolve));
  await stopTestServers();
});

beforeEach(async () => {
  stub.rootStatus = 200;
  stub.rootBody = { version: '2.1.1', clientName: 'evolution' };
  stub.serverOkStatus = 404;
  stub.serverOkBody = { error: 'not found' };
  stub.listStatus = 200;
  stub.listBody = [{ name: 'instancia-existente', connectionStatus: 'open' }];
  stub.adminKeyVisto = null;
  volta.modo = 'painel';
  // O teto é de seis por minuto, e a suíte faz mais que isso. Zerado por caso
  // em vez de afrouxado no produto: o limitador existe porque um clique aqui
  // faz o painel emitir quatro requisições para endereços de terceiros, e
  // alargá-lo para caber num arquivo de teste seria testar outro programa. O
  // caso que prova que ele está montado está no fim deste arquivo.
  whatsappTestLimiter.resetKey(`user:${userId}`);
  await salvar({});
});

describe('a configuração inteira certa', () => {
  it('os seis passos passam, sem número nenhum conectado', async () => {
    const { status, body } = await testar();
    assert.equal(status, 200);
    assert.equal(veredito(body, 'config'), 'ok');
    assert.equal(veredito(body, 'webhookPath'), 'ok');
    assert.equal(veredito(body, 'server'), 'ok');
    assert.equal(detalhe(body, 'server'), 'v2');
    assert.equal(veredito(body, 'license'), 'ok');
    assert.equal(veredito(body, 'adminKey'), 'ok');
    assert.equal(veredito(body, 'roundTrip'), 'reached');
    assert.equal(stub.adminKeyVisto, ADMIN_KEY, 'a listagem foi sem a chave admin salva');
  });
});

describe('a volta, que é o motivo de tudo isto existir', () => {
  it('200 SEM o nonce é FALHA, e é o caso que originou a sonda', async () => {
    // `webhookBaseUrl` apontando para a raiz do painel: o frontend devolve HTML
    // com 200, o Evolution registra entrega bem-sucedida, e nada chega nunca.
    // Tudo parece certo dos dois lados — é o pior dos três jeitos de errar.
    volta.modo = 'sintetico';
    volta.status = 200;
    volta.corpo = '<!doctype html><html><body>SkyGenPanel</body></html>';
    const { body } = await testar();
    assert.equal(veredito(body, 'roundTrip'), 'wrong_target');
  });

  it('caminho parecido e errado é `not_found`, não "destino errado"', async () => {
    volta.modo = 'sintetico';
    volta.status = 404;
    volta.corpo = '{"error":"not found"}';
    const { body } = await testar();
    assert.equal(veredito(body, 'roundTrip'), 'not_found');
  });

  it('falha de transporte é veredito, não exceção', async () => {
    volta.modo = 'transporte';
    const { status, body } = await testar();
    assert.equal(status, 200, 'o operador pediu um diagnóstico; "não deu para chegar" É o diagnóstico');
    assert.equal(veredito(body, 'roundTrip'), 'unreachable');
  });

  it('e ela roda mesmo com o servidor Evolution fora do ar', async () => {
    // Servidor caído com webhook certo é um estado real. Calar sobre a volta
    // aqui perderia justamente a informação que o operador foi buscar.
    await salvar({
      managedUrl: 'https://fora-do-ar.provedor.test',
      allowedHosts: 'evo.provedor.test\nfora-do-ar.provedor.test'
    });
    const { body } = await testar();
    assert.equal(veredito(body, 'server'), 'unreachable');
    assert.equal(veredito(body, 'roundTrip'), 'reached');
  });
});

describe('o que um passo bloqueado NÃO pode afirmar', () => {
  it('servidor inalcançável não diz nada sobre licença nem sobre a chave admin', async () => {
    await salvar({
      managedUrl: 'https://fora-do-ar.provedor.test',
      allowedHosts: 'evo.provedor.test\nfora-do-ar.provedor.test'
    });
    const { body } = await testar();
    assert.equal(veredito(body, 'server'), 'unreachable');
    assert.equal(veredito(body, 'license'), 'skipped');
    assert.equal(veredito(body, 'adminKey'), 'skipped', 'afirmou sobre a chave de um servidor que não respondeu');
  });

  it('a integração desligada não afirma nada sobre nada', async () => {
    await asTenant(() => WhatsAppConfigService.saveConfig({ enabled: false }));
    const { body } = await testar();
    assert.equal(veredito(body, 'config'), 'disabled');
    for (const passo of ['webhookPath', 'server', 'license', 'adminKey', 'roundTrip']) {
      assert.equal(veredito(body, passo), 'skipped', `${passo} afirmou algo sem configuração`);
    }
  });
});

describe('chave admin errada é distinguida de servidor fora do ar', () => {
  it('401 do servidor vira `unauthorized`, e a licença continua ok', async () => {
    stub.listStatus = 401;
    stub.listBody = { message: 'Unauthorized' };
    const { body } = await testar();
    assert.equal(veredito(body, 'server'), 'ok', 'o servidor respondeu; dizê-lo fora do ar seria mentira');
    assert.equal(veredito(body, 'license'), 'ok');
    assert.equal(veredito(body, 'adminKey'), 'unauthorized');
  });
});

describe('a licença é reconhecida como licença', () => {
  it('o 503 LICENSE_REQUIRED não vira "erro do servidor"', async () => {
    // Uma distribuição licenciada recusa TODA rota com o mesmo 503, raiz
    // inclusive. Sem reconhecer a forma, o operador vai conferir URL e chave —
    // que estão certas.
    stub.rootStatus = 503;
    stub.rootBody = {
      code: 'LICENSE_REQUIRED',
      error: 'service not activated',
      register_url: 'https://evo.provedor.test/manager/login'
    };
    const { body } = await testar();
    assert.equal(veredito(body, 'license'), 'required');
    assert.equal(detalhe(body, 'license'), 'https://evo.provedor.test/manager/login');
    assert.equal(veredito(body, 'adminKey'), 'skipped');
    assert.notEqual(veredito(body, 'server'), 'unknown_flavor',
      'licença lida depois do sabor vira "não parece um Evolution" — o diagnóstico que não dá para agir em cima');
  });
});

describe('o que atende e não é um Evolution', () => {
  it('não é chamado de v2 por falta de resposta conclusiva', async () => {
    // `flavorFromProbes` cai para 'v2' quando nada é conclusivo, e está certo
    // para criar instância. Para diagnosticar, isso mandaria o operador conferir
    // a chave admin de um servidor que não existe.
    stub.rootStatus = 502;
    stub.rootBody = { error: 'bad gateway' };
    stub.serverOkStatus = 502;
    stub.serverOkBody = { error: 'bad gateway' };
    const { body } = await testar();
    assert.equal(veredito(body, 'server'), 'unknown_flavor');
    assert.equal(veredito(body, 'adminKey'), 'skipped');
  });
});

describe('a permissão e a trilha', () => {
  it('a rota exige `whatsapp.config`', async () => {
    const { status } = await call(`${panelUrl}/api/whatsapp/test`, { method: 'POST' });
    assert.equal(status, 401);
  });

  it('a execução deixa linha na trilha, com os vereditos e sem segredo', async () => {
    await testar();
    const { body } = await call(`${panelUrl}/api/audit?action=whatsapp.config_tested`, {
      headers: authHeaders(token)
    });
    const linha = body.data.entries?.[0] ?? body.data.logs?.[0] ?? body.data[0];
    assert.ok(linha, 'a execução não deixou linha na trilha');
    const texto = JSON.stringify(linha);
    assert.ok(texto.includes('roundTrip'), 'a linha não registra os vereditos');
    assert.ok(!texto.includes(ADMIN_KEY), 'a chave admin foi parar na trilha');
  });
});

describe('o limitador, que este roteador não tinha', () => {
  it('o sétimo teste no mesmo minuto é recusado', async () => {
    // Um clique emite até quatro requisições de saída para endereços que quem
    // administra escolheu. Seis por minuto cobre alguém consertando um campo e
    // testando de novo; o resto é rajada.
    for (let i = 0; i < 6; i += 1) {
      const { status } = await testar();
      assert.equal(status, 200, `a tentativa ${i + 1} devia caber no minuto`);
    }
    const { status, body } = await testar();
    assert.equal(status, 429);
    assert.equal(body.code, 'rate_limited');
  });
});

describe('as recusas que acontecem antes de abrir socket', () => {
  it('servidor fora da lista de autorizados tem veredito próprio', async () => {
    // Conserto diferente de "fora do ar": um é acrescentar o host à lista, o
    // outro é levantar o servidor. Um veredito só mandaria metade dos
    // operadores para o lado errado.
    await salvar({ managedUrl: 'https://outro.provedor.test' });
    const { body } = await testar();
    assert.equal(veredito(body, 'server'), 'host_not_allowed');
    assert.equal(veredito(body, 'adminKey'), 'skipped');
  });

  it('e http simples também, porque a credencial iria em claro', async () => {
    await asTenant(() => WhatsAppConfigService.saveConfig({ managedUrl: 'http://evo.provedor.test' }));
    const { body } = await testar();
    assert.equal(veredito(body, 'server'), 'insecure_base_url');
  });
});
