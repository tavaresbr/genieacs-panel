import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listRoutes } from './helpers/routeInventory.js';
import { casos } from './helpers/idSweepCases.js';

/**
 * A lista de portas, e a exigência de que nenhuma fique sem resposta.
 *
 * As outras suítes de tenancy provam que uma porta específica está fechada.
 * Esta prova outra coisa, que nenhuma delas consegue: que **não sobrou porta
 * fora da lista**. É um teste de contabilidade, e é de propósito — o vazamento
 * que este projeto viu de perto não foi um controlador escrito errado, foi um
 * controlador novo copiado do vizinho e ninguém lembrar de escrever a prova
 * dele. Uma rota nova aqui reprova o CI até alguém dizer, por escrito, quem
 * prova que ela está fechada.
 *
 * Três contas, e nenhuma delas aceita entrada velha: uma rota declarada que não
 * existe mais reprova junto com uma rota nova não declarada, porque uma tabela
 * que só cresce vira decoração.
 *
 * O que este arquivo NÃO faz é chamar rota nenhuma. Quem chama é a varredura em
 * `tenant-id-sweep.test.js`; aqui se confere que ela chama todas as que devia.
 */
const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** O que estabelece uma sessão. Qualquer outra coisa na frente da rota é limite ou papel. */
const GUARDAS_DE_SESSAO = new Set([
  'authenticateToken',
  'authenticatePortalCustomer',
  // O coletor de métricas: sem sessão, mas com segredo próprio conferido em
  // tempo constante, e ele mesmo cai no guarda do console quando não há token.
  'allowMetricsScraper'
]);

/**
 * Toda rota que responde sem sessão, e por quê.
 *
 * Cada uma destas é uma porta aberta para a internet. Não há nada de errado com
 * isso — é como se entra, como um ERP entrega evento e como um assinante lê a
 * própria fatura —, mas cada uma tem que ter sido escolhida, e é isso que a
 * lista registra. A conta é dos dois lados: uma rota nova sem sessão reprova,
 * e uma entrada aqui cuja rota sumiu também.
 */
const PUBLICAS = new Map([
  ['GET /api/tenant/public', 'o nome do provedor para a tela de login, atrás do resolvedor — quem responde é o host'],
  ['GET /api/auth/setup-status', 'a instalação já tem alguém? é a pergunta que a tela de instalação faz antes de existir sessão'],
  ['POST /api/auth/setup', 'cria a primeira conta do provedor; recusa se já houver uma'],
  ['POST /api/auth/signup', 'um ISP se cadastra; só na edição SaaS e só onde há domínio-base'],
  ['POST /api/auth/login', 'a porta de entrada'],
  ['POST /api/auth/refresh', 'renova a sessão com o refresh token, que é a credencial aqui'],
  ['GET /api/invites/token/:token', 'o token do convite É a credencial, e é conferido por hash'],
  ['POST /api/invites/token/:token/accept', 'idem, e a senha da pessoa é conferida quando a conta já existe'],
  ['POST /api/sgp/events/webhook', 'entrega do ERP, autenticada pelo segredo do webhook'],
  ['POST /api/whatsapp-webhook', 'entrega da Evolution, montada antes do resolvedor e autenticada pelo token da instância'],
  ['GET /api/whatsapp-media/:id', 'anexo servido por um token assinado que já nomeia o provedor; prova em whatsapp-media-tenancy.test.js'],
  ['POST /api/customer/login', 'a porta de entrada do assinante, no listener do portal']
]);

/**
 * Toda rota endereçada por um parâmetro, e quem prova que o parâmetro do
 * vizinho não alcança a linha dele.
 *
 * `'varredura'` quer dizer "está em `tenant-id-sweep.test.js`", e isso é
 * conferido de verdade contra a lista de casos. Qualquer outro valor é o
 * motivo escrito de por que a varredura não serve ali — e o motivo tem que
 * nomear onde a prova está, porque "não se aplica" sem endereço é como uma
 * porta some da lista.
 */
const POR_ID = new Map([
  // --- Ids que não são desta casa: vêm do GenieACS, e são iguais para quem
  // apontar dois painéis para o mesmo ACS. Quem os separa é o conector por
  // provedor (Fase 4) e as tabelas escopadas que os indexam.
  ['DELETE /api/devices/faults/:faultId', 'a falha é lida do GenieACS do provedor, não é linha daqui'],
  ['GET /api/devices/:deviceId/history', 'id do aparelho no GenieACS; o histórico é escopado, prova em tenant-leak.test.js'],
  ['GET /api/devices/:deviceId/swaps', 'id do aparelho no GenieACS; device_swaps é escopada, prova em tenant-leak.test.js'],
  ['GET /api/devices/:deviceId/portal-password', 'id do aparelho; a conta do assinante é escopada, prova em tenant-leak.test.js'],
  ['POST /api/devices/:deviceId/portal-password/reset', 'idem, e a redefinição pela conta do vizinho está em tenant-leak.test.js'],
  ['GET /api/devices/:deviceId', 'id do aparelho no GenieACS de cada provedor'],
  ['DELETE /api/devices/:deviceId', 'idem; o que apaga é o aparelho no ACS daquele provedor'],
  ['POST /api/devices/:id/update-wan', 'id do aparelho no GenieACS'],
  ['POST /api/devices/:id/add-wan', 'id do aparelho no GenieACS'],
  ['PUT /api/devices/:id/installation-date', 'id do aparelho; device_profiles é escopada, prova em device-profiles-tenancy.test.js'],
  ['POST /api/devices/:id/update-wifi', 'id do aparelho no GenieACS'],
  ['POST /api/devices/:id/update-credentials', 'id do aparelho no GenieACS'],
  ['GET /api/sgp/devices/:deviceId', 'id do aparelho; sgp_links é escopada, prova em sgp-links-tenancy.test.js'],
  ['POST /api/sgp/devices/:deviceId/link', 'idem — os dois provedores podem vincular o mesmo id, e é o que sgp-links-tenancy.test.js prova'],
  ['DELETE /api/sgp/devices/:deviceId/link', 'idem'],
  ['POST /api/sgp/devices/:deviceId/unlock', 'idem'],
  ['POST /api/sgp/devices/:deviceId/ticket', 'idem'],
  ['GET /api/provisioning/devices/:deviceId/runs', 'id do aparelho; provisioning_runs é escopada, prova em provisioning-tenancy.test.js'],
  ['POST /api/provisioning/devices/:deviceId/preview', 'idem'],
  ['POST /api/provisioning/devices/:deviceId/provision', 'idem'],

  // --- Chaves naturais que os dois provedores têm iguais. Aqui a pergunta não
  // é "o id do vizinho alcança a linha dele?" — o id é o mesmo — e sim "cada um
  // vê a sua". Isso é colisão, e é a suíte de vazamento que responde.
  ['GET /api/settings/:key', 'a chave é a mesma palavra nos dois; cada um lê a sua, prova em tenant-leak.test.js'],
  ['PUT /api/settings/:key', 'idem, e a escrita de um não altera a do outro'],
  ['DELETE /api/settings/:key', 'idem, e o apagar de um não apaga a do outro'],
  ['GET /api/vendor-management/wifi-security-configs/by-product-class/:productClass', 'classe de produto do fabricante, igual nos dois; prova em vendor-catalogue-tenancy.test.js'],
  ['GET /api/vendor-management/:vendorId/wifi-security', 'lista escopada; o fabricante do vizinho devolve nada, prova em vendor-catalogue-tenancy.test.js'],
  ['PUT /api/whatsapp/subscribers/:contract/phone', 'o contrato é do SGP e os dois podem tê-lo; prova em tenant-leak.test.js'],
  ['GET /api/customer/wifi/:index/password', 'índice do rádio no aparelho, não linha; a sessão do portal é escopada, prova em tenant-subdomain.test.js'],

  // --- Anexo servido por token assinado.
  ['GET /api/whatsapp/messages/:id/media', 'prova própria em whatsapp-media-tenancy.test.js, que pede a mídia da mensagem do vizinho'],
  ['GET /api/whatsapp-media/:id', 'idem, pelo token assinado, antes do resolvedor'],

  // --- O convite: o token é o segredo, não um id de linha.
  ['GET /api/invites/token/:token', 'o token é a credencial e nomeia o provedor; prova em tenant-invites.test.js'],
  ['POST /api/invites/token/:token/accept', 'idem'],

  // --- O plano de controle está ACIMA dos provedores: aqui o id de outro
  // provedor é o trabalho da rota, não um vazamento. O que se prova nessas é
  // que quem não é da plataforma recebe 404.
  ['PATCH /api/platform/tenants/:id', 'plano de controle; o 404 de quem não é da plataforma está em platform-tenants.test.js'],
  ['DELETE /api/platform/tenants/:id', 'plano de controle; prova em platform-tenant-delete.test.js'],
  ['GET /api/platform/tenants/:id/members', 'plano de controle; prova em platform-members.test.js'],
  ['POST /api/platform/tenants/:id/members', 'plano de controle; prova em platform-members.test.js'],
  ['DELETE /api/platform/tenants/:id/members/:userId', 'plano de controle; prova em platform-members.test.js'],
  ['PATCH /api/platform/plans/:id', 'plano de controle; prova em platform-billing.test.js'],
  ['GET /api/platform/tenants/:id/subscription', 'plano de controle; prova em platform-billing.test.js'],
  ['PUT /api/platform/tenants/:id/subscription', 'plano de controle; prova em platform-billing.test.js'],
  ['POST /api/platform/tenants/:id/payments', 'plano de controle; prova em platform-billing.test.js'],
  ['GET /api/platform/tenants/:id/usage', 'plano de controle; prova em platform-billing.test.js']
]);

// Todo caso da varredura entra aqui sozinho: a lista dela é a fonte, e repetir
// os rótulos à mão seria a mesma coisa escrita duas vezes.
for (const caso of casos) POR_ID.set(caso.label, 'varredura');

const rotas = listRoutes();
const chave = (r) => `${r.method} ${r.path}`;

describe('o inventário de rotas', () => {
  it('encontra as rotas dos dois listeners', () => {
    // Um número redondo demais seria um teste que ninguém entende quando
    // quebra: o que se exige é que os dois apps tenham sido varridos e que o
    // total seja grande o bastante para não ser um parser que achou meia dúzia.
    const painel = rotas.filter((r) => r.app === 'app');
    const portal = rotas.filter((r) => r.app === 'portalApp');
    assert.ok(painel.length > 100, `poucas rotas de painel: ${painel.length}`);
    assert.ok(portal.length >= 8, `poucas rotas de portal: ${portal.length}`);
    for (const r of rotas) {
      assert.match(r.path, /^\/api\//, `rota fora de /api: ${chave(r)}`);
      assert.ok(r.handlers.length > 0, `rota sem handler: ${chave(r)}`);
    }
  });
});

describe('toda rota sem sessão', () => {
  const semSessao = rotas.filter((r) => !r.handlers.some((h) => GUARDAS_DE_SESSAO.has(h)));

  it('está declarada, com o motivo escrito', () => {
    const naoDeclaradas = semSessao.map(chave).filter((k) => !PUBLICAS.has(k));
    assert.deepEqual(naoDeclaradas, [],
      'rota nova sem guarda de sessão: feche a porta ou declare-a em PUBLICAS com o motivo');
  });

  it('e nenhuma declaração sobrou de uma rota que não existe mais', () => {
    const atuais = new Set(semSessao.map(chave));
    const orfas = [...PUBLICAS.keys()].filter((k) => !atuais.has(k));
    assert.deepEqual(orfas, [], 'entrada em PUBLICAS sem rota correspondente');
  });

  it('não é nenhuma que escreva no cadastro de outro provedor', () => {
    // As de escrita entre as públicas são exatamente estas, e a lista existe
    // para que uma sexta chame a atenção de quem revisa.
    const escritas = semSessao
      .filter((r) => r.method !== 'GET')
      .map(chave)
      .sort();
    assert.deepEqual(escritas, [
      'POST /api/auth/login',
      'POST /api/auth/refresh',
      'POST /api/auth/setup',
      'POST /api/auth/signup',
      'POST /api/customer/login',
      'POST /api/invites/token/:token/accept',
      'POST /api/sgp/events/webhook',
      'POST /api/whatsapp-webhook'
    ]);
  });
});

describe('toda rota endereçada por um parâmetro', () => {
  const comParametro = rotas.filter((r) => /:/.test(r.path));

  it('tem quem prove que o parâmetro do vizinho não alcança a linha dele', () => {
    const semProva = comParametro.map(chave).filter((k) => !POR_ID.has(k));
    assert.deepEqual(semProva, [],
      'rota nova endereçada por id: ponha-a na varredura ou declare em POR_ID onde está a prova');
  });

  it('e nenhuma declaração sobrou de uma rota que não existe mais', () => {
    const atuais = new Set(comParametro.map(chave));
    const orfas = [...POR_ID.keys()].filter((k) => !atuais.has(k));
    assert.deepEqual(orfas, [], 'entrada em POR_ID sem rota correspondente');
  });

  // Um teto, não uma meta: o número só pode cair. Declarar motivo é mais fácil
  // do que escrever caso, e sem esta linha o caminho fácil não custa nada —
  // baixar o teto junto com uma exceção nova é o pedágio de quem toma esse
  // caminho, e é o que faz alguém pensar duas vezes.
  //
  // As 41 de hoje são, todas: id de aparelho no GenieACS (20), chave natural
  // que os dois provedores têm igual (7), anexo por token assinado (2), token
  // de convite (2) e o plano de controle (10).
  const TETO_DE_EXCECOES = 41;

  it('deixa de fora só as que têm motivo, e não mais do que hoje', () => {
    const naoVarridas = comParametro
      .filter((r) => POR_ID.get(chave(r)) !== 'varredura')
      .map(chave);
    assert.ok(naoVarridas.length <= TETO_DE_EXCECOES,
      `${naoVarridas.length} rotas com id fora da varredura, e o teto é ${TETO_DE_EXCECOES}:\n  ${naoVarridas.join('\n  ')}`);
  });
});

describe('a varredura de ids', () => {
  it('não tem caso apontando para rota que não existe', () => {
    const atuais = new Set(rotas.map(chave));
    const fantasmas = casos.map((c) => c.label).filter((l) => !atuais.has(l));
    assert.deepEqual(fantasmas, [], 'caso da varredura sem rota correspondente');
  });

  it('não tem dois casos com o mesmo rótulo', () => {
    const vistos = new Set();
    const repetidos = [];
    for (const caso of casos) {
      if (vistos.has(caso.label)) repetidos.push(caso.label);
      vistos.add(caso.label);
    }
    assert.deepEqual(repetidos, []);
  });

  it('diz de que tabela é cada caso, e a tabela é escopada', async () => {
    const { SCOPED_TABLES } = await import('../src/config/tenantScope.js');
    for (const caso of casos) {
      assert.ok(caso.tabela, `${caso.label}: sem tabela`);
      assert.ok(caso.chave, `${caso.label}: sem chave de seed`);
      // `users` é do deploy e não do provedor: quem responde 404 ali é o
      // vínculo em `tenant_users`, com prova própria em users-tenancy.test.js.
      if (caso.tabela === 'users') continue;
      assert.ok(SCOPED_TABLES.has(caso.tabela),
        `${caso.label}: ${caso.tabela} não está na lista de tabelas escopadas`);
    }
  });
});

describe('cada prova nomeada em uma declaração', () => {
  it('é um arquivo de teste que existe', () => {
    const citados = new Set();
    for (const motivo of [...POR_ID.values(), ...PUBLICAS.values()]) {
      for (const m of String(motivo).matchAll(/([a-z0-9-]+\.test\.js)/g)) citados.add(m[1]);
    }
    assert.ok(citados.size >= 8, `poucas provas citadas: ${citados.size}`);
    for (const arquivo of citados) {
      assert.ok(fs.existsSync(path.join(RAIZ, 'test', arquivo)),
        `a declaração cita ${arquivo}, que não existe`);
    }
  });
});

describe('a ordem das montagens em app.js', () => {
  const fonte = fs.readFileSync(path.join(RAIZ, 'src', 'app.js'), 'utf8');
  const linhas = fonte.split('\n');
  const indiceDe = (regex) => linhas.findIndex((l) => regex.test(l));

  it('põe o resolvedor de provedor antes de todo roteador', () => {
    const resolvedor = indiceDe(/^app\.use\('\/api', resolveTenant\);/);
    assert.ok(resolvedor > 0, 'o resolvedor não está montado em /api');

    // Um roteador montado ACIMA desta linha atende sem provedor em escopo. É a
    // falha que o comentário do `/api/tenant` no próprio app.js descreve, e o
    // teste existe para que ela não volte por uma linha no lugar errado.
    const montagens = linhas
      .map((l, i) => ({ i, l }))
      .filter(({ l }) => /^\s*app\.use\('\/api\/[^']*',\s*\w+Routes\);/.test(l));
    assert.ok(montagens.length > 10, 'poucas montagens encontradas');
    const acima = montagens.filter(({ i }) => i < resolvedor).map(({ l }) => l.trim());
    assert.deepEqual(acima, [
      // As duas exceções, e as duas são entregas de fora que trazem o provedor
      // no próprio corpo ou no token assinado.
      "app.use('/api/whatsapp-webhook', whatsappWebhookRoutes);",
      "app.use('/api/whatsapp-media', whatsappMediaRoutes);"
    ]);
  });

  it('põe a porta da assinatura logo depois do resolvedor, nos dois listeners', () => {
    const painel = indiceDe(/^app\.use\('\/api', resolveTenant\);/);
    const portaPainel = indiceDe(/^\s*app\.use\('\/api', requireActiveSubscription\(\)\);/);
    assert.ok(portaPainel > painel, 'a porta da assinatura não vem depois do resolvedor');

    const portal = indiceDe(/^portalApp\.use\('\/api', resolveTenant\);/);
    const portaPortal = indiceDe(/^\s*portalApp\.use\('\/api', requireActiveSubscription\(\{ portal: true \}\)\);/);
    assert.ok(portal > 0 && portaPortal > portal, 'o portal não repete a mesma ordem');
  });

  it('não monta a troca de banco nem o console fora da sua edição', () => {
    assert.match(fonte, /if \(IS_SELF_HOSTED\) \{\n\s*app\.use\('\/api\/database', databaseRoutes\);/);
    assert.match(fonte, /if \(IS_SAAS\) \{[\s\S]*app\.use\('\/api\/platform', platformRoutes\);/);
  });
});
