import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: SgpContactSyncService } = await import('../src/services/sgpContactSyncService.js');

/**
 * Todos os clientes do SGP nos contatos do WhatsApp, com ou sem contrato, com
 * ou sem equipamento.
 *
 * O caminho da listagem é configurado por instalação — a referência da URA não
 * tem uma chamada "liste todos". O SGP falso daqui responde nele com páginas
 * por `offset`/`limit`, em três formatos que as versões do SGP usam: cliente
 * com contratos aninhados, cliente sem contrato, e um caminho que ignora a
 * paginação e devolve sempre a mesma página.
 */

const APP = 'painel';
const TOKEN = 'token-da-listagem';
const LIST_PATH = '/api/ura/clientes/';
const BROKEN_PATH = '/api/ura/clientes-sem-pagina/';
/** Answers an empty list when asked without a filter. */
const EMPTY_PATH = '/api/ura/clientes-vazio/';
/** Refuses outright without a filter, the way an URA call does. */
const FILTER_PATH = '/api/ura/clientes-com-filtro/';
const INSTANCE = 'painel-sync-contatos';
const WEBHOOK_TOKEN = 'segredo-do-webhook-sync';

/** O cadastro do SGP falso. Mutável: um teste dá contrato a quem não tinha. */
const clientes = [];
for (let i = 1; i <= 21; i += 1) {
  clientes.push({
    id: 1000 + i,
    nome: `Cliente ${String(i).padStart(2, '0')}`,
    cpfcnpj: String(10000000000 + i),
    celular: `55939911${String(10000 + i).slice(-5)}`,
    contratos: [{ contrato: `K-${i}`, contratoStatus: i % 7 === 0 ? 'Cancelado' : 'Ativo' }]
  });
}
// Dois contratos num cliente só.
clientes.push({
  id: 2001,
  nome: 'Maria Duas Casas',
  cpfcnpj: '55566677788',
  telefones: ['(93) 3522-1234', '(93) 98111-3333'],
  contratos: [
    { contrato: 'K-DUAS-1', contratoStatus: 'Ativo' },
    { contrato: 'K-DUAS-2', contratoStatus: 'Suspenso' }
  ]
});
// Cadastro sem contrato nenhum.
clientes.push({ id: 3001, nome: 'João Sem Contrato', cpfcnpj: '99988877766', celular: '93 99222-4444', contratos: [] });

let panelUrl;
let token;
let beta;
let accountId;
let sgpServer;
let lastListPayload = null;

const auth = () => ({ headers: authHeaders(token) });
const sincronizar = () => call(`${panelUrl}/api/sgp/contacts/sync`, { method: 'POST', ...auth() });
// Direto no serviço: a rota tem o limitador da sincronização de frota, que é o
// certo em produção e acaba com o orçamento de um arquivo de testes.
const sincronizarDireto = () => asTenant(() => SgpContactSyncService.syncAll());
const testar = () => call(`${panelUrl}/api/sgp/contacts/test`, { method: 'POST', ...auth() });
const contatos = (query = '') => call(`${panelUrl}/api/whatsapp/contacts${query}`, auth());
const linhas = () => asTenant(() => getDb()('sgp_contacts').orderBy('id'));
const configurar = (patch) => asTenant(() => SgpService.saveConfig(patch));
const hook = (body) => call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, { method: 'POST', body });

function startSgpStub() {
  sgpServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
      const send = (data) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (payload.app !== APP || payload.token !== TOKEN) return send({ status: 0, msg: 'Token inválido' });
      if (req.url.startsWith(LIST_PATH)) {
        lastListPayload = payload;
        const offset = Number(payload.offset) || 0;
        const limit = Number(payload.limit) || 10;
        return send({ status: 1, clientes: clientes.slice(offset, offset + limit) });
      }
      if (req.url.startsWith(EMPTY_PATH)) return send({ status: 1, clientes: [] });
      if (req.url.startsWith(FILTER_PATH)) return send({ status: 0, msg: 'Informe ao menos um filtro' });
      if (req.url.startsWith(BROKEN_PATH)) {
        return send({ status: 1, clientes: clientes.slice(0, Number(payload.limit) || 10) });
      }
      return send({ status: 0, msg: 'Endpoint inexistente' });
    });
  });
  return new Promise((resolve) => {
    sgpServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${sgpServer.address().port}`));
  });
}

function eventoV2({ id, remoteJid }) {
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid, fromMe: false, id },
      pushName: 'Cliente',
      message: { conversation: 'oi' },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  };
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const sgpUrl = await startSgpStub();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;

  const db = getDb();
  await db('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta' }).first()).id;

  await configurar({ enabled: true, baseUrl: sgpUrl, app: APP, token: TOKEN, linkMode: 'manual', contactsPageSize: 10 });
  const account = await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.provedor.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-da-instancia-sync'),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  }));
  accountId = account.id;

  // Um contrato que já tem ONT: a listagem continua mostrando só uma vez.
  await asTenant(() => db('sgp_links').insert({
    device_id: 'ONT-K1', contract: 'K-1', client_name: 'Cliente 01', state: 'active', link_mode: 'manual',
    phone_e164: '5593991110001'
  }));

  // O cadastro sem contrato do vizinho.
  await runInTenant(beta, () => db('sgp_contacts').insert({
    tenant_id: beta, contract: null, sgp_client_id: '9999', client_name: 'Do Beta', state: 'none'
  }));
});

after(async () => {
  await new Promise((resolve) => sgpServer.close(resolve));
  await stopTestServers();
});

describe('o caminho padrão', () => {
  it('é /api/ura/clientes/, sem ninguém precisar preencher', async () => {
    const config = await asTenant(() => SgpService.getConfig());
    assert.equal(config.endpoints.customerList, '/api/ura/clientes/');
  });

  it('também para quem salvou o campo vazio na versão anterior', async () => {
    await configurar({ endpoints: { customerList: '' } });
    const config = await asTenant(() => SgpService.getConfig());
    assert.equal(config.endpoints.customerList, '/api/ura/clientes/');
  });
});

describe('o botão de testar', () => {
  it('lê só a primeira página e não grava nada', async () => {
    assert.equal(LIST_PATH, '/api/ura/clientes/');
    const res = await testar();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.received, 10);
    assert.ok(res.body.data.fields.includes('contratos'));
    assert.equal((await linhas()).filter((row) => Number(row.tenant_id) !== Number(beta)).length, 0);
  });
});

describe('a sincronização completa', () => {
  let resultado;

  before(async () => {
    resultado = await sincronizar();
  });

  it('percorre todas as páginas', async () => {
    assert.equal(resultado.status, 200, JSON.stringify(resultado.body));
    assert.equal(resultado.body.data.partial, false);
    assert.equal(resultado.body.data.pages, 3);
    // 21 clientes com um contrato, um com dois, um sem nenhum.
    assert.equal(resultado.body.data.total, 24);
    assert.equal(resultado.body.data.withoutContract, 1);
    assert.equal(lastListPayload.limit, 10);
  });

  it('guarda uma linha por contrato, e a do cliente sem contrato', async () => {
    const todas = await linhas();
    const duas = todas.filter((row) => ['K-DUAS-1', 'K-DUAS-2'].includes(row.contract));
    assert.equal(duas.length, 2);
    assert.equal(duas[0].phone_e164, '5593981113333', 'o celular da lista, não o fixo');
    assert.equal(duas.find((row) => row.contract === 'K-DUAS-2').state, 'blocked');

    const joao = todas.find((row) => row.client_name === 'João Sem Contrato');
    assert.equal(joao.contract, null);
    assert.equal(joao.sgp_client_id, '3001');
    assert.equal(joao.state, 'none');
    assert.equal(joao.phone_e164, '5593992224444');
    assert.ok(joao.last_seen_at);
  });

  it('não apaga a correção do operador ao sincronizar de novo', async () => {
    await asTenant(() => getDb()('sgp_contacts').where({ contract: 'K-5' }).update({ phone_manual: '5521900000005' }));
    const again = await sincronizar();
    assert.equal(again.body.data.updated, 24);
    assert.equal(again.body.data.created, 0);
    const k5 = (await linhas()).find((row) => row.contract === 'K-5');
    assert.equal(k5.phone_manual, '5521900000005');
  });

  it('diz quando foi a última', async () => {
    const res = await call(`${panelUrl}/api/sgp/contacts/sync`, auth());
    assert.equal(res.status, 200);
    assert.equal(res.body.data.total, 24);
  });
});

describe('na aba Contatos', () => {
  it('mostra quem tem e quem não tem contrato, sem repetir o que tem ONT', async () => {
    const res = await contatos('?limit=200');
    const lista = res.body.data.contacts;
    assert.equal(lista.filter((c) => c.contract === 'K-1').length, 1);
    assert.equal(lista.find((c) => c.contract === 'K-1').hasDevice, true);
    const joao = lista.find((c) => c.clientName === 'João Sem Contrato');
    assert.equal(joao.hasContract, false);
    assert.match(joao.key, /^c:\d+$/);
    assert.ok(!lista.some((c) => c.clientName === 'Do Beta'), 'o cadastro do vizinho não aparece');
  });

  it('filtra por situação', async () => {
    const semContrato = await contatos('?state=none');
    assert.deepEqual(semContrato.body.data.contacts.map((c) => c.clientName), ['João Sem Contrato']);
    const cancelados = await contatos('?state=cancelled');
    assert.deepEqual(cancelados.body.data.contacts.map((c) => c.contract).sort(), ['K-14', 'K-21', 'K-7']);
  });
});

describe('conversa com um cliente sem contrato', () => {
  let chave;
  let fioId;

  before(async () => {
    const res = await contatos('?state=none');
    chave = res.body.data.contacts[0].key;
  });

  it('abre pela chave, vinculada à linha e não a um contrato inventado', async () => {
    const res = await call(`${panelUrl}/api/whatsapp/contacts/${encodeURIComponent(chave)}/conversation`, {
      method: 'POST', ...auth()
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.contract, null);
    assert.equal(res.body.data.clientName, 'João Sem Contrato');
    assert.equal(`c:${res.body.data.sgpContactId}`, chave);
    fioId = res.body.data.id;
  });

  it('a resposta dele cai no mesmo fio, mesmo sem o nono dígito', async () => {
    await hook(eventoV2({ id: 'MSG-SEM-CONTRATO', remoteJid: '559392224444@s.whatsapp.net' }));
    const fios = await asTenant(() => getDb()('wa_conversations')
      .whereIn('wa_phone_e164', ['5593992224444', '559392224444']));
    assert.deepEqual(fios.map((f) => f.id), [fioId], 'nenhum segundo fio pela outra grafia');
    assert.equal(fios[0].unread_count, 1);
  });

  it('um número desconhecido pode ser vinculado a ele à mão', async () => {
    await hook(eventoV2({ id: 'MSG-PARENTE', remoteJid: '5521955550000@s.whatsapp.net' }));
    const parente = await asTenant(() => WaConversation.getByThread(accountId, '5521955550000@s.whatsapp.net'));
    const res = await call(`${panelUrl}/api/whatsapp/conversations/${parente.id}/subscriber`, {
      method: 'POST', ...auth(), body: { contract: chave, savePhone: true }
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.clientName, 'João Sem Contrato');
    const joao = (await linhas()).find((row) => row.client_name === 'João Sem Contrato');
    assert.equal(joao.phone_manual, '5521955550000');
  });

  it('não alcança o cadastro do vizinho pela chave', async () => {
    const doBeta = await runInTenant(beta, () => getDb()('sgp_contacts').where({ sgp_client_id: '9999' }).first());
    const res = await call(`${panelUrl}/api/whatsapp/contacts/${encodeURIComponent(`c:${doBeta.id}`)}/conversation`, {
      method: 'POST', ...auth()
    });
    assert.equal(res.status, 404);
  });

  it('quando ganha contrato no SGP, a linha sem contrato sai e a conversa segue com ele', async () => {
    const joao = clientes.find((c) => c.id === 3001);
    joao.contratos = [{ contrato: 'K-NOVO', contratoStatus: 'Ativo' }];
    await sincronizar();

    const todas = await linhas();
    assert.ok(!todas.some((row) => row.sgp_client_id === '3001'), 'a linha sem contrato foi aposentada');
    const novo = todas.find((row) => row.contract === 'K-NOVO');
    assert.equal(novo.phone_manual, '5521955550000', 'a correção do operador foi junto');

    const fio = await asTenant(() => WaConversation.getById(fioId));
    assert.equal(fio.contract, 'K-NOVO');
    assert.equal(fio.sgp_contact_id, null);
  });
});

describe('um SGP que não lista sem filtro', () => {
  it('uma primeira página vazia é avisada, não comemorada', async () => {
    await configurar({ endpoints: { customerList: EMPTY_PATH } });
    const res = await sincronizarDireto();
    assert.equal(res.partial, true);
    assert.equal(res.reason, 'empty');
    assert.equal(res.total, 0);
  });

  it('a recusa chega com a frase do próprio SGP', async () => {
    await configurar({ endpoints: { customerList: FILTER_PATH } });
    const res = await testar();
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'sgp_rejected');
    assert.match(res.body.message, /Informe ao menos um filtro/);
    await assert.rejects(sincronizarDireto(), (error) => error.code === 'sgp_rejected');
  });
});

describe('um SGP que ignora a paginação', () => {
  it('para na segunda página em vez de ler a primeira para sempre', async () => {
    await configurar({ endpoints: { customerList: BROKEN_PATH } });
    const res = await sincronizar();
    assert.equal(res.status, 200);
    assert.equal(res.body.data.partial, true);
    assert.equal(res.body.data.reason, 'paging_ignored');
    assert.equal(res.body.data.pages, 2);
  });
});
