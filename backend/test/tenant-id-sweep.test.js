import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * O portão da Fase 8, na forma que o plano exige: **`GET /:id` com id de B
 * respondendo 404 e não 403**, varrido sobre TODA rota do painel endereçada por
 * id de linha — não sobre uma.
 *
 * A prova que já existia cobria dois endpoints (`portal-password` em
 * `tenant-leak`, `users` em `users-tenancy`). São 24 aqui, e a diferença não é
 * de quantidade: cada rota tem seu próprio caminho até o banco, e é a rota que
 * alguém acrescenta depois — copiando o controlador vizinho e trocando o modelo
 * — que vaza. Uma lista fecha isso por construção: acrescentar rota por id sem
 * acrescentar linha aqui deixa o buraco sem teste, e acrescentar a linha custa
 * uma linha.
 *
 * O controle é o que dá sentido ao 404. Cada caso roda DUAS vezes, com o mesmo
 * token, o mesmo host e o mesmo corpo — só o id muda:
 *
 *   1. beta pedindo o id do alfa  → tem que ser 404, e nunca 403;
 *   2. beta pedindo o id do beta  → tem que ser qualquer coisa MENOS 404.
 *
 * Sem (2) o arquivo inteiro passaria com as rotas quebradas, com o token
 * inválido, ou com o seed nunca tendo gravado nada — um 404 é o que se recebe
 * de graça. Com (2), o 404 de (1) só pode ser o escopo.
 *
 * Por que 404 e não 403: um 403 confirma que a linha existe. Perguntando id por
 * id, um provedor mapeia quantos fabricantes, campanhas e eventos o vizinho
 * tem, sem ler um único campo. O corpo da resposta é a resposta.
 *
 * O que a reversão mostrou, para quem for mexer nisto depois. Tirando o `where`
 * de `tdb()` (e desarmando a sentinela de SQL, que sozinha já derruba o seed
 * antes de qualquer rota rodar), **22 dos 24 casos ficam vermelhos**. Os dois
 * que continuam verdes são os de `/api/users/:id`, e continuam por estarem
 * certos: `users` é tabela do deploy, não de um provedor — a linha é uma
 * PESSOA, e um consultor que atende dois ISPs com um login só é o arranjo comum
 * deste mercado. Quem responde 404 ali não é o filtro, é a leitura do vínculo
 * em `tenant_users` dentro de `UsersController`, que é outro mecanismo e tem
 * prova própria em `users-tenancy.test.js`. Vale dizer porque a conclusão
 * preguiçosa — "o filtro cobre tudo" — é falsa, e porque uma rota nova sobre
 * `users` não herda nada daqui.
 */

process.env.TENANT_BASE_DOMAIN = 'painel.exemplo.com';
process.env.PORTAL_BASE_DOMAIN = 'portal.exemplo.com';

const { getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { runInTenant } = await import('../src/config/tenantContext.js');
const { tinsertReturningId } = await import('../src/config/database.js');

const { default: User } = await import('../src/models/User.js');
const { default: TenantUser } = await import('../src/models/TenantUser.js');

/**
 * Requisição com `Host` escolhido — `fetch` não faz isto: `Host` é header
 * proibido lá e o undici o substitui em silêncio, de modo que um teste escrito
 * com `fetch` passaria provando nada. É a mesma razão de `tenant-subdomain`.
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

let panelUrl;
let alfa;
let beta;
let betaToken;

/** Os ids semeados de cada provedor, por chave de caso. */
const ids = { alfa: {}, beta: {} };

const PAINEL_BETA = 'beta.painel.exemplo.com';

/**
 * Semeia, para um provedor, uma linha de cada tabela que uma rota por id
 * alcança. Os valores colidem de propósito entre os dois provedores — o mesmo
 * telefone, a mesma `dedupe_key`, o mesmo nome de perfil, o mesmo par de ONTs —
 * porque é assim no mundo real e porque é a colisão que revela um índice único
 * que ficou valendo para o deploy inteiro.
 */
async function semear(tenantId, slug) {
  return runInTenant(tenantId, async () => {
    const bcrypt = (await import('bcryptjs')).default;

    /**
     * Uma linha, e o id dela, conferido na hora.
     *
     * `tinsertReturningId` cru e nunca o `create` do modelo, de propósito. Quase
     * todo `create` daqui lê antes de escrever — `WaOptOut.record` consulta
     * `isActive`, `SgpEvent.insertIfNew` consulta a `dedupe_key`,
     * `Vendor.create` consulta o nome — e todas essas leituras passam pelo
     * MESMO filtro que este arquivo existe para testar. Semeando por elas, o
     * dia em que o filtro cair o seed é que quebra, o `before` estoura, e os 24
     * casos aparecem como "cancelled" em vez de vermelhos: a falha some
     * justamente quando importa. O fixture tem que ser independente do
     * mecanismo sob teste.
     *
     * O `assert` é o resto: sem ele um seed vazio viraria "Cannot read
     * properties of null" dentro do hook, que também não diz qual linha faltou.
     */
    const semearLinha = async (tabela, linha) => {
      const id = await tinsertReturningId(tabela, linha);
      assert.ok(id, `seed do ${slug}: ${tabela} não foi gravada`);
      return id;
    };

    const alvo = {};

    // `users` é do deploy, não de um provedor: a linha é uma PESSOA e quem
    // decide o acesso é o vínculo em `tenant_users`. Por isso esta entra pelo
    // modelo — não há filtro de provedor a contornar aqui.
    const userId = await User.create({
      username: `alvo-${slug}`,
      password: await bcrypt.hash(`senha-do-alvo-${slug}-1`, 10),
      role: 'admin'
    });
    await TenantUser.create({ tenantId, userId, role: 'admin' });
    assert.ok(userId, `seed do ${slug}: users não foi gravada`);
    alvo.user = userId;

    alvo.template = await semearLinha('wa_templates', {
      name: 'segunda-via', body: 'Olá {{nome}}', category: 'cobranca', active: true
    });

    // O mesmo número nos dois: uma pessoa pode ser assinante dos dois
    // provedores e ter pedido silêncio a um só.
    alvo.optOut = await semearLinha('wa_opt_outs', {
      wa_phone_e164: '5511900000001', origin: 'customer', created_at: new Date()
    });

    alvo.broadcast = await semearLinha('wa_broadcasts', {
      title: 'Aviso de manutenção', body: 'Teste', status: 'draft'
    });

    alvo.account = await semearLinha('whatsapp_accounts', {
      name: `skygp_sweep_${slug}`,
      purpose: 'support',
      flavor: 'v2',
      // Porta 9 (discard), fechada: se alguma rota chegasse à rede em vez de
      // parar no escopo, o teste falharia por recusa de conexão em vez de
      // pendurar — e é isso que se quer saber.
      base_url: 'http://127.0.0.1:9',
      status: 'connected'
    });

    // A mesma `dedupe_key` nos dois. Ela é construída do id sequencial que o
    // ERP daquele provedor emitiu, então o evento nº 12345 de um ISP e o de
    // outro colidem — é a colisão que o índice único por provedor existe para
    // permitir.
    alvo.event = await semearLinha('sgp_events', {
      dedupe_key: 'sgp-evento-12345',
      source: 'webhook',
      type: 'suspend',
      contract: '4242',
      status: 'pending',
      payload: '{}'
    });

    alvo.profile = await semearLinha('provisioning_profiles', {
      name: 'perfil-padrao', priority: 10, enabled: true
    });

    alvo.swap = await semearLinha('device_swaps', {
      previous_device_id: 'ONT-ANTIGA-0001',
      device_id: 'ONT-NOVA-0001',
      matched_by: 'pppoe',
      link_action: 'kept'
    });

    alvo.vendor = await semearLinha('vendors', {
      name: 'Fabricante Comum',
      manufacturer_patterns: JSON.stringify(['ACME']),
      product_patterns: JSON.stringify(['AC-1000']),
      parameter_prefix: 'InternetGatewayDevice'
    });

    alvo.wifiConfig = await semearLinha('wifi_security_config', {
      product_class: 'AC-1000',
      security_types: 'WPA2',
      password_param_path: 'WLANConfiguration.1.KeyPassphrase'
    });

    alvo.mapping = await semearLinha('wifi_security_mappings', {
      vendor_id: alvo.vendor,
      raw_security_value: '11i',
      normalized_security: 'WPA2',
      description: 'WPA2 pessoal'
    });

    return alvo;
  });
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();

  const primeiro = await db('tenants').orderBy('id', 'asc').first();
  await db('tenants').where({ id: primeiro.id }).update({ slug: 'alfa', name: 'Provedor Alfa' });
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  alfa = primeiro.id;
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  // O administrador do beta é quem faz as perguntas. Criado direto porque
  // `/auth/setup` só cunha o primeiro administrador de um provedor que não tem
  // nenhum, e o vínculo é a parte que decide: sem linha em `tenant_users` a
  // pessoa não entra e o token viria indefinido.
  const bcrypt = (await import('bcryptjs')).default;
  const betaUserId = await runInTenant(beta, () => User.create({
    username: 'operador-beta',
    password: bcrypt.hashSync('senha-do-beta-1', 10),
    role: 'admin'
  }));
  await runInTenant(beta, () => TenantUser.create({
    tenantId: beta, userId: betaUserId, role: 'admin'
  }));
  const login = await callAs(PAINEL_BETA, `${panelUrl}/api/auth/login`, {
    method: 'POST',
    body: { username: 'operador-beta', password: 'senha-do-beta-1' }
  });
  betaToken = login.body?.data?.token;
  assert.ok(betaToken, 'o operador do beta precisa de um token');

  ids.alfa = await semear(alfa, 'alfa');
  ids.beta = await semear(beta, 'beta');

  // A integração do WhatsApp ligada NO BETA, de propósito. Sem ela as rotas de
  // instância param em `requireConfig` antes de olhar o id, e um 400 dizendo
  // "não configurado" provaria só que o beta não configurou nada. Ligada, o
  // único obstáculo que resta entre o beta e a instância do alfa é o escopo —
  // que é exatamente a afirmação sob teste.
  const config = await callAs(PAINEL_BETA, `${panelUrl}/api/whatsapp/config`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${betaToken}` },
    body: { enabled: true, webhookBaseUrl: 'https://webhook.beta.exemplo.com' }
  });
  assert.equal(config.status, 200, 'o beta precisa ter a integração ligada');
});

after(async () => {
  await stopTestServers();
});

/**
 * Toda rota do painel endereçada por id de linha.
 *
 * Ficam de fora, com motivo: `/api/devices/:id/*`, cujo `:id` é o id do
 * aparelho no GenieACS e não uma linha daqui; `/api/whatsapp-media/:id`, que
 * corre antes do resolvedor e tem prova própria em
 * `whatsapp-media-tenancy.test.js`; e `/api/platform/tenants/:id`, que é do
 * plano de controle — está acima dos provedores, não dentro de um, e
 * `platform-tenants.test.js` cobre o 404 de quem não é administrador de
 * plataforma.
 */
const casos = [
  {
    chave: 'user',
    label: 'PATCH /api/users/:id',
    method: 'PATCH',
    path: (id) => `/api/users/${id}`,
    body: { role: 'viewer' },
    tabela: 'users'
  },
  {
    chave: 'user',
    label: 'DELETE /api/users/:id',
    method: 'DELETE',
    path: (id) => `/api/users/${id}`,
    tabela: 'users'
  },
  {
    chave: 'template',
    label: 'PUT /api/whatsapp/templates/:id',
    method: 'PUT',
    path: (id) => `/api/whatsapp/templates/${id}`,
    body: { name: 'segunda-via', body: 'Outro texto', category: 'cobranca' },
    tabela: 'wa_templates'
  },
  {
    chave: 'template',
    label: 'DELETE /api/whatsapp/templates/:id',
    method: 'DELETE',
    path: (id) => `/api/whatsapp/templates/${id}`,
    tabela: 'wa_templates'
  },
  {
    chave: 'optOut',
    label: 'DELETE /api/whatsapp/opt-outs/:id',
    method: 'DELETE',
    path: (id) => `/api/whatsapp/opt-outs/${id}`,
    tabela: 'wa_opt_outs'
  },
  {
    chave: 'broadcast',
    label: 'POST /api/whatsapp/broadcasts/:id/status',
    method: 'POST',
    path: (id) => `/api/whatsapp/broadcasts/${id}/status`,
    body: { status: 'canceled' },
    tabela: 'wa_broadcasts'
  },
  {
    chave: 'account',
    label: 'GET /api/whatsapp/accounts/:id/qr',
    method: 'GET',
    path: (id) => `/api/whatsapp/accounts/${id}/qr`,
    tabela: 'whatsapp_accounts',
    // O beta chegaria à rede se o id resolvesse, e a porta 9 está fechada: o
    // controle abaixo aceita o erro de transporte, e o que ele exige é que a
    // resposta não seja `account_not_found`.
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'GET /api/whatsapp/accounts/:id/status',
    method: 'GET',
    path: (id) => `/api/whatsapp/accounts/${id}/status`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/restart',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/restart`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'POST /api/whatsapp/accounts/:id/disconnect',
    method: 'POST',
    path: (id) => `/api/whatsapp/accounts/${id}/disconnect`,
    tabela: 'whatsapp_accounts',
    controleSoNaoAchou: true
  },
  {
    chave: 'account',
    label: 'PATCH /api/whatsapp/accounts/:id',
    method: 'PATCH',
    path: (id) => `/api/whatsapp/accounts/${id}`,
    body: { label: 'Renomeado pelo vizinho' },
    tabela: 'whatsapp_accounts'
  },
  {
    chave: 'event',
    label: 'GET /api/sgp/events/:id',
    method: 'GET',
    path: (id) => `/api/sgp/events/${id}`,
    tabela: 'sgp_events'
  },
  {
    chave: 'event',
    label: 'POST /api/sgp/events/:id/retry',
    method: 'POST',
    path: (id) => `/api/sgp/events/${id}/retry`,
    tabela: 'sgp_events'
  },
  {
    chave: 'profile',
    label: 'PUT /api/provisioning/profiles/:id',
    method: 'PUT',
    path: (id) => `/api/provisioning/profiles/${id}`,
    body: { name: 'perfil-padrao', priority: 20, enabled: true },
    tabela: 'provisioning_profiles'
  },
  {
    chave: 'profile',
    label: 'DELETE /api/provisioning/profiles/:id',
    method: 'DELETE',
    path: (id) => `/api/provisioning/profiles/${id}`,
    tabela: 'provisioning_profiles'
  },
  {
    chave: 'swap',
    label: 'POST /api/devices/swaps/:id/acknowledge',
    method: 'POST',
    path: (id) => `/api/devices/swaps/${id}/acknowledge`,
    tabela: 'device_swaps'
  },
  {
    chave: 'vendor',
    label: 'GET /api/vendor-management/:id',
    method: 'GET',
    path: (id) => `/api/vendor-management/${id}`,
    tabela: 'vendors'
  },
  {
    chave: 'vendor',
    label: 'PUT /api/vendor-management/:id',
    method: 'PUT',
    path: (id) => `/api/vendor-management/${id}`,
    body: {
      name: 'Fabricante Comum',
      manufacturer_patterns: ['ACME'],
      product_patterns: ['AC-1000'],
      parameter_prefix: 'InternetGatewayDevice'
    },
    tabela: 'vendors'
  },
  {
    chave: 'mapping',
    label: 'PUT /api/vendor-management/wifi-security/:id',
    method: 'PUT',
    path: (id) => `/api/vendor-management/wifi-security/${id}`,
    body: { raw_security_value: '11i', normalized_security: 'WPA3', description: 'trocado' },
    tabela: 'wifi_security_mappings'
  },
  {
    chave: 'mapping',
    label: 'DELETE /api/vendor-management/wifi-security/:id',
    method: 'DELETE',
    path: (id) => `/api/vendor-management/wifi-security/${id}`,
    tabela: 'wifi_security_mappings'
  },
  {
    chave: 'wifiConfig',
    label: 'GET /api/vendor-management/wifi-security-configs/:id',
    method: 'GET',
    path: (id) => `/api/vendor-management/wifi-security-configs/${id}`,
    tabela: 'wifi_security_config'
  },
  {
    chave: 'wifiConfig',
    label: 'PUT /api/vendor-management/wifi-security-configs/:id',
    method: 'PUT',
    path: (id) => `/api/vendor-management/wifi-security-configs/${id}`,
    body: {
      product_class: 'AC-1000',
      security_types: ['WPA2'],
      password_param_path: 'WLANConfiguration.1.KeyPassphrase'
    },
    tabela: 'wifi_security_config'
  },
  {
    chave: 'wifiConfig',
    label: 'DELETE /api/vendor-management/wifi-security-configs/:id',
    method: 'DELETE',
    path: (id) => `/api/vendor-management/wifi-security-configs/${id}`,
    tabela: 'wifi_security_config'
  },
  // O fabricante por último entre os do catálogo: apagá-lo leva os mapeamentos
  // junto pela chave estrangeira, e os casos acima precisam da linha de pé.
  {
    chave: 'vendor',
    label: 'DELETE /api/vendor-management/:id',
    method: 'DELETE',
    path: (id) => `/api/vendor-management/${id}`,
    tabela: 'vendors'
  }
];

/** A linha crua, com provedor e tudo — nunca por um modelo. */
const cru = (tabela, id) => getDb()(tabela).where({ id }).first();

describe('o operador do beta pedindo, no host do beta, o id do alfa', () => {
  for (const caso of casos) {
    it(`${caso.label} responde 404`, async () => {
      const id = ids.alfa[caso.chave];
      assert.ok(id, `o seed do alfa precisa ter gravado ${caso.chave}`);
      const antes = await cru(caso.tabela, id);
      assert.ok(antes, 'a linha do alfa tem que existir antes da chamada');

      const { status, body } = await callAs(PAINEL_BETA, `${panelUrl}${caso.path(id)}`, {
        method: caso.method,
        headers: { Authorization: `Bearer ${betaToken}` },
        body: caso.body
      });

      // As duas afirmações separadas de propósito: a primeira é o contrato, a
      // segunda é o que se perderia se alguém "consertasse" o 404 para 403 por
      // achar mais honesto.
      assert.equal(status, 404, `${caso.label}: ${JSON.stringify(body)}`);
      assert.notEqual(status, 403);

      // E a linha do alfa tem que estar como estava. Um 404 devolvido DEPOIS de
      // escrever é o pior dos dois mundos, e é uma falha que nenhum código de
      // status revela.
      assert.deepEqual(await cru(caso.tabela, id), antes,
        `${caso.label}: a linha do alfa foi tocada`);
    });
  }
});

/**
 * O controle, e a razão de o arquivo inteiro querer dizer alguma coisa.
 *
 * Mesma rota, mesmo token, mesmo host, mesmo corpo — só o id muda, do alfa para
 * o beta. Se isto também desse 404, os 404 acima seriam de graça: rota errada,
 * token recusado, seed vazio, qualquer coisa.
 *
 * Roda depois porque metade destes casos apaga a linha que usa.
 */
describe('a mesma pergunta com o id do próprio beta', () => {
  for (const caso of casos) {
    it(`${caso.label} não responde 404`, async () => {
      const id = ids.beta[caso.chave];
      assert.ok(id, `o seed do beta precisa ter gravado ${caso.chave}`);

      const { status, body } = await callAs(PAINEL_BETA, `${panelUrl}${caso.path(id)}`, {
        method: caso.method,
        headers: { Authorization: `Bearer ${betaToken}` },
        body: caso.body
      });

      if (caso.controleSoNaoAchou) {
        // Estas alcançam a rede quando o id resolve, e a porta está fechada de
        // propósito. O que se exige é que a instância tenha sido ENCONTRADA:
        // qualquer falha de transporte serve, `account_not_found` não.
        assert.notEqual(body?.code, 'account_not_found',
          `${caso.label}: o beta não achou a própria instância`);
        return;
      }
      assert.notEqual(status, 404, `${caso.label}: ${JSON.stringify(body)}`);
    });
  }
});
