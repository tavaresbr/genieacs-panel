import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { asTenant, authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: TeiahService, normalizeConsult } = await import('../src/services/teiahService.js');
const { tinsert } = await import('../src/config/database.js');
const { default: TeiahConsultation } = await import('../src/models/TeiahConsultation.js');

/**
 * A TeiaH para quem já é cliente: a consulta grava um instantâneo na ficha,
 * "Aplicar" o junta à ficha sem tirar nada, e a busca em lote só olha quem está
 * ativo e sem telefone. A TeiaH falsa responde por CPF e conta as consultas.
 */

const TEIAH_KEY = 'chave-teiah-ficha';
// CPFs válidos.
const CPF_A = '81373563044';
const CPF_B = '52998224725';
const CPF_C = '11144477735';
const CPF_D = '39053344705';
// Para o cache: um achado, um que a TeiaH não conhece e um que dá erro.
const CPF_E = '12345678909';
const CPF_NAO_ACHADO = '98765432100';
const CPF_ERRO = '45317828791';

const RESPOSTAS = {
  [CPF_A]: {
    resultado: {
      mix: {
        score: { data: { risco: 'BAIXO', score: 700 } },
        emails: { data: ['A@EXEMPLO.TEST', 'a2@exemplo.test'] },
        pessoa: { data: { nome: 'ANA DA TEIAH', nomeMae: 'MARIA DA TEIAH', dataNascimento: '01/04/1985' } },
        telefones: { data: [{ ddd: '93', numero: '35221234' }, { ddd: '93', numero: '991234567' }] },
        enderecos: {
          data: [
            { tipoLogradouro: 'RUA', logradouro: 'DAS FLORES', numero: '10', bairro: 'CENTRO', cidade: 'ITAITUBA', uf: 'pa', cep: '68180-000' },
            { logradouro: 'AV BRASIL', numero: '99', bairro: 'JARDIM', cidade: 'ITAITUBA', uf: 'pa', cep: '68180-111' }
          ]
        }
      }
    }
  },
  // Sem telefone nenhum: a TeiaH conhece, mas não tem número.
  [CPF_B]: { resultado: { mix: { pessoa: { data: { nome: 'BIA SEM FONE' } }, emails: { data: ['bia@exemplo.test'] } } } },
  [CPF_C]: {
    resultado: { mix: { pessoa: { data: { nome: 'CARLOS' } }, telefones: { data: [{ ddd: '93', numero: '988887777' }] } } }
  },
  [CPF_E]: {
    resultado: {
      mix: {
        pessoa: { data: { nome: 'EVA DO CACHE' } },
        telefones: { data: [{ ddd: '93', numero: '966665555' }] },
        enderecos: { data: [{ logradouro: 'RUA DO CACHE', numero: '1', bairro: 'CENTRO', cidade: 'ITAITUBA', uf: 'pa', cep: '68180-000' }] }
      }
    }
  },
  [CPF_D]: { resultado: { mix: { pessoa: { data: { nome: 'DIOGO' } }, telefones: { data: [{ ddd: '93', numero: '977776666' }] } } } }
};

let panelUrl;
let token;
let teiahServer;
const consultas = [];
// O histórico de consultas da TeiaH: o pedido de relatório lê daqui.
const historico = [];
const HISTORICO = [
  { id: 'c-antiga', documento: '813.735.630-44', createdAt: '2026-10-01T10:00:00Z', imprimivel: true },
  { id: 'c-nova', documento: '813.735.630-44', createdAt: '2026-11-01T10:00:00Z', imprimivel: true },
  // A busca é solta: um documento que só começa igual não é este cliente.
  { id: 'c-outro', documento: '813.735.999-99', createdAt: '2026-11-05T10:00:00Z', imprimivel: true },
  { id: 'c-falhou', documento: '813.735.630-44', createdAt: '2026-11-04T10:00:00Z', imprimivel: false },
  { id: 'sem-dados', documento: '111.444.777-35', createdAt: '2026-11-01T10:00:00Z', imprimivel: true }
];
// A consulta por endereço: o que a TeiaH recebeu, e o histórico dessas consultas.
const enderecosConsultados = [];
const HISTORICO_ENDERECO = [
  { id: 'e-certo', tipo: 'ENDERECO', cep: '68180430', numero: '398', createdAt: '2026-11-02T10:00:00Z', imprimivel: true },
  // Mesmo CEP, outro número: não é a casa consultada.
  { id: 'e-vizinho', tipo: 'ENDERECO', cep: '68180430', numero: '400', createdAt: '2026-11-05T10:00:00Z', imprimivel: true }
];
// Para o teste do erro: a TeiaH fora do ar não deixa nada guardado.
let teiahFora = false;
const auth = () => ({ headers: authHeaders(token) });

function startTeiahStub() {
  teiahServer = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers['x-api-key'] !== TEIAH_KEY) return send(401, { message: 'API Key inválida' });
      // O histórico e o PDF do relatório: leitura do que a TeiaH já guardou.
      if (req.method === 'GET') {
        const url = new URL(req.url, 'http://teiah');
        historico.push(url);
        if (url.pathname === '/api/consultations') {
          const search = url.searchParams.get('search');
          if (url.searchParams.get('type') === 'ENDERECO') {
            return send(200, { data: HISTORICO_ENDERECO.filter((item) => item.cep === search) });
          }
          return send(200, { total: 3, data: HISTORICO.filter((item) => item.documento.replace(/\D/g, '').startsWith(search.slice(0, 6))) });
        }
        const pdf = url.pathname.match(/^\/api\/consultations\/([\w-]+)\/pdf$/);
        if (pdf) {
          if (pdf[1] === 'sem-dados') { res.writeHead(204); return res.end(); }
          res.writeHead(200, { 'Content-Type': 'application/pdf' });
          return res.end(`%PDF-1.4 relatorio ${pdf[1]} ${url.searchParams.get('mode')}`);
        }
        return send(404, {});
      }
      if (req.url === '/api/whatsapp/consulta') {
        const body = JSON.parse(raw || '{}');
        enderecosConsultados.push(body);
        if (body.cep === '68180-430') {
          return send(201, { resultado: { score: { data: { score: 420, risco: 'ALTO' } }, dividas: { data: [{ valor: '150,00' }, { valor: '50' }] } } });
        }
        return send(201, { mensagem: 'Nenhum registro para este endereço' });
      }
      const { cpf } = JSON.parse(raw || '{}');
      consultas.push(cpf);
      if (teiahFora) return send(503, { message: 'indisponível' });
      return RESPOSTAS[cpf] ? send(201, RESPOSTAS[cpf]) : send(404, {});
    });
  });
  return new Promise((resolve) => {
    teiahServer.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${teiahServer.address().port}`));
  });
}

async function addContract(contract, name, document, extra = {}) {
  await asTenant(() => tinsert('sgp_contacts', {
    contract, client_name: name, document, state: 'active', phone_e164: null, last_synced_at: new Date(), ...extra
  }));
  return contract;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  const url = await startTeiahStub();
  await asTenant(() => TeiahService.saveConfig({ enabled: true, baseUrl: url, apiKey: TEIAH_KEY }));
});

after(async () => {
  await asTenant(() => TeiahService.saveConfig({ enabled: false }));
  await new Promise((done) => teiahServer.close(done));
  await stopTestServers();
});

describe('o que a consulta traz', () => {
  it('lê todos os telefones, e-mails e endereços, a mãe e o score', () => {
    const result = normalizeConsult(RESPOSTAS[CPF_A]);
    assert.deepEqual(result.emails, ['a@exemplo.test', 'a2@exemplo.test']);
    // O celular primeiro.
    assert.deepEqual(result.phones, ['5593991234567', '559335221234']);
    assert.equal(result.motherName, 'MARIA DA TEIAH');
    assert.equal(result.addresses.length, 2);
    assert.equal(result.addresses[0].street, 'RUA DAS FLORES');
    assert.equal(result.address.zip, '68180000');
    assert.equal(result.score.score, 700);
  });

  it('acha telefones e e-mails fora das seções esperadas', () => {
    const result = normalizeConsult({
      resultado: { mix: { pessoa: { data: { nome: 'X' } }, contato: { data: { celular: { ddd: '93', numero: '911112222' }, email_principal: 'x@exemplo.test' } } } }
    });
    assert.deepEqual(result.phones, ['5593911112222']);
    assert.deepEqual(result.emails, ['x@exemplo.test']);
  });
});

describe('consultar e aplicar na ficha', () => {
  it('a consulta grava o instantâneo e a ficha o mostra; aplicar junta sem repetir', async () => {
    await addContract('T-100', 'Ana Cliente', CPF_A);
    const antes = await call(`${panelUrl}/api/contacts/T-100/teiah/apply`, { method: 'POST', ...auth() });
    assert.equal(antes.status, 409, 'aplicar sem consultar não tem o que aplicar');
    assert.equal(antes.body.code, 'teiah_not_consulted');

    const consulta = await call(`${panelUrl}/api/contacts/T-100/teiah`, { method: 'POST', ...auth() });
    assert.equal(consulta.status, 200, JSON.stringify(consulta.body));
    assert.equal(consulta.body.data.teiah.motherName, 'MARIA DA TEIAH');

    const ficha = await call(`${panelUrl}/api/contacts/T-100`, auth());
    assert.equal(ficha.body.data.teiahReady, true);
    assert.equal(ficha.body.data.teiahWebUrl, 'https://valid.teiah.ai', 'o botão Abrir TeiaH precisa do endereço do painel');
    assert.equal(ficha.body.data.teiah.score.score, 700);
    assert.equal(ficha.body.data.teiah.addresses.length, 2);

    const aplicado = await call(`${panelUrl}/api/contacts/T-100/teiah/apply`, { method: 'POST', ...auth() });
    assert.equal(aplicado.status, 200, JSON.stringify(aplicado.body));
    assert.equal(aplicado.body.data.phonesAdded, 2);
    assert.equal(aplicado.body.data.emailsAdded, 2);
    assert.equal(aplicado.body.data.whatsappSet, 1);
    const depois = aplicado.body.data.profile;
    assert.deepEqual(depois.fields.phones.value.sort(), ['559335221234', '5593991234567']);
    assert.equal(depois.whatsappPhone, '5593991234567', 'o celular vira o WhatsApp de quem não tinha número');
    assert.equal(depois.fields.phones.edited, true);

    const outra = await call(`${panelUrl}/api/contacts/T-100/teiah/apply`, { method: 'POST', ...auth() });
    assert.equal(outra.body.data.phonesAdded, 0);
    assert.equal(outra.body.data.whatsappSet, 0);
  });

  it('não troca o WhatsApp de quem já tem número', async () => {
    await addContract('T-110', 'Ana Com Número', CPF_A, { phone_e164: '5593900000000' });
    await call(`${panelUrl}/api/contacts/T-110/teiah`, { method: 'POST', ...auth() });
    const aplicado = await call(`${panelUrl}/api/contacts/T-110/teiah/apply`, { method: 'POST', ...auth() });
    assert.equal(aplicado.body.data.whatsappSet, 0);
    assert.equal(aplicado.body.data.profile.whatsappPhone, '5593900000000');
  });

  it('a trilha não leva o documento nem o número', async () => {
    const rows = await asTenant(() => getDb()('audit_log').whereIn('action', ['contact.teiah_lookup', 'contact.teiah_applied']));
    assert.ok(rows.length >= 2);
    for (const row of rows) {
      assert.equal(row.detail.includes(CPF_A), false);
      assert.equal(row.detail.includes('5593991234567'), false);
    }
  });

  it('um cliente sem CPF/CNPJ válido não é consultado', async () => {
    await addContract('T-120', 'Sem Documento', null);
    const res = await call(`${panelUrl}/api/contacts/T-120/teiah`, { method: 'POST', ...auth() });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_document');
  });
});

describe('a busca em lote dos clientes sem telefone', () => {
  it('consulta só quem está ativo, sem telefone e com documento; prévia e aplicar', async () => {
    await addContract('L-1', 'Bia Sem Fone', CPF_B);
    await addContract('L-2', 'Carlos Sem Fone', CPF_C);
    await addContract('L-3', 'Diogo Cancelado', CPF_D, { state: 'cancelled' });
    await addContract('L-4', 'Com Número', CPF_D, { phone_e164: '5593955550000' });
    consultas.length = 0;

    const scan = await call(`${panelUrl}/api/contacts/teiah/phones/scan`, { method: 'POST', ...auth() });
    assert.equal(scan.status, 200, JSON.stringify(scan.body));
    assert.equal(scan.body.data.remaining, 0);
    assert.deepEqual([...new Set(consultas)].sort(), [CPF_B, CPF_C].sort(), 'só os ativos sem telefone');

    // Uma segunda passada não repete a consulta paga.
    consultas.length = 0;
    const outra = await call(`${panelUrl}/api/contacts/teiah/phones/scan`, { method: 'POST', ...auth() });
    assert.equal(outra.body.data.processed, 0);
    assert.deepEqual(consultas, []);

    const prévia = await call(`${panelUrl}/api/contacts/teiah/phones`, auth());
    assert.equal(prévia.status, 200);
    // A Bia não tem telefone na TeiaH: não aparece. O Carlos tem.
    assert.deepEqual(prévia.body.data.rows.map((row) => row.key), ['L-2']);
    assert.deepEqual(prévia.body.data.rows[0].phones, ['5593988887777']);

    const aplicado = await call(`${panelUrl}/api/contacts/teiah/phones/apply`, { method: 'POST', ...auth(), body: { keys: ['L-2', 'L-inexistente'] } });
    assert.equal(aplicado.status, 200, JSON.stringify(aplicado.body));
    assert.equal(aplicado.body.data.clients, 1);
    assert.equal(aplicado.body.data.skipped, 1);

    const depois = await call(`${panelUrl}/api/contacts/teiah/phones`, auth());
    assert.deepEqual(depois.body.data.rows, [], 'quem recebeu o número sai da lista de sem telefone');
    const ficha = await call(`${panelUrl}/api/contacts/L-2`, auth());
    assert.equal(ficha.body.data.whatsappPhone, '5593988887777');
  });
});

describe('não consultar de novo o que foi consultado há pouco', () => {
  const lookup = (document, fresh = false) => call(`${panelUrl}/api/contacts/lookup/document?document=${document}${fresh ? '&fresh=1' : ''}`, auth());
  const saved = (document) => asTenant(() => getDb()('teiah_consultations').where({ document }).first());
  const age = (document, days) => asTenant(() => getDb()('teiah_consultations').where({ document })
    .update({ consulted_at: new Date(Date.now() - days * 86_400_000) }));
  const count = (cpf) => consultas.filter((c) => c === cpf).length;

  it('abrir o Novo cliente duas vezes para o mesmo CPF paga uma consulta só', async () => {
    consultas.length = 0;
    const first = await lookup(CPF_E);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.data.prefill.name, 'EVA DO CACHE');
    assert.equal(first.body.data.teiahCached, false);
    const second = await lookup(CPF_E);
    assert.equal(second.body.data.prefill.name, 'EVA DO CACHE');
    assert.equal(second.body.data.prefill.address.city, 'ITAITUBA');
    assert.equal(second.body.data.teiahCached, true);
    assert.ok(second.body.data.teiahConsultedAt);
    assert.equal(count(CPF_E), 1);
  });

  it('pedir uma consulta nova (fresh) paga e substitui o que estava guardado', async () => {
    const before = count(CPF_E);
    const res = await lookup(CPF_E, true);
    assert.equal(res.body.data.teiahCached, false);
    assert.equal(count(CPF_E), before + 1);
  });

  it('a ficha reaproveita a consulta do Novo cliente', async () => {
    await addContract('T-200', 'Eva Cliente', CPF_E);
    const before = count(CPF_E);
    const res = await call(`${panelUrl}/api/contacts/T-200/teiah`, { method: 'POST', ...auth() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.cached, true);
    assert.deepEqual(res.body.data.teiah.phones, ['5593966665555']);
    assert.equal(count(CPF_E), before, 'nenhuma chamada à TeiaH');

    const forcada = await call(`${panelUrl}/api/contacts/T-200/teiah`, { method: 'POST', ...auth(), body: { fresh: true } });
    assert.equal(forcada.body.data.cached, false);
    assert.equal(count(CPF_E), before + 1);
  });

  it('o achado vale 30 dias e o não achado, 7', async () => {
    consultas.length = 0;
    await lookup(CPF_NAO_ACHADO);
    await lookup(CPF_NAO_ACHADO);
    assert.equal(count(CPF_NAO_ACHADO), 1, 'o "não achado" também é guardado');

    await age(CPF_NAO_ACHADO, 6);
    await lookup(CPF_NAO_ACHADO);
    assert.equal(count(CPF_NAO_ACHADO), 1, 'com 6 dias ainda vale');
    await age(CPF_NAO_ACHADO, 8);
    await lookup(CPF_NAO_ACHADO);
    assert.equal(count(CPF_NAO_ACHADO), 2, 'com 8 dias, pergunta de novo');

    await age(CPF_E, 29);
    const before = count(CPF_E);
    await lookup(CPF_E);
    assert.equal(count(CPF_E), before, 'o achado com 29 dias ainda vale');
    await age(CPF_E, 31);
    await lookup(CPF_E);
    assert.equal(count(CPF_E), before + 1, 'com 31 dias, pergunta de novo');
  });

  it('a TeiaH com erro não deixa nada guardado', async () => {
    teiahFora = true;
    try {
      const res = await lookup(CPF_ERRO);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.prefillError, true);
      assert.equal(await saved(CPF_ERRO), undefined);
    } finally {
      teiahFora = false;
    }
  });

  it('o cache é de um provedor só, e a trilha leva só se veio do cache', async () => {
    await asTenant(() => getDb()('tenants').where({ slug: 'beta' }).first())
      || await getDb()('tenants').insert({ slug: 'beta', name: 'Provedor Beta', status: 'active' });
    const beta = (await getDb()('tenants').where({ slug: 'beta' }).first()).id;
    assert.equal(await runInTenant(beta, () => TeiahConsultation.get(CPF_E)), null);

    const rows = await asTenant(() => getDb()('audit_log').where({ action: 'contact.teiah_lookup' }));
    assert.ok(rows.some((row) => JSON.parse(row.detail).cached === true));
    for (const row of rows) assert.equal(row.detail.includes(CPF_E), false);
  });
});

describe('relatório da TeiaH na ficha', () => {
  const relatorio = (key, mode) => fetch(`${panelUrl}/api/contacts/${key}/teiah/report${mode ? `?mode=${mode}` : ''}`, auth());

  it('traz o PDF da consulta mais recente do histórico, sem consultar de novo', async () => {
    await addContract('R-100', 'Relatório Cliente', CPF_A);
    const antes = consultas.length;
    historico.length = 0;
    const res = await relatorio('R-100');
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-disposition'), /^inline; filename="teiah-81373563044-completo\.pdf"$/);
    assert.equal(await res.text(), '%PDF-1.4 relatorio c-nova completo');
    assert.equal(consultas.length, antes, 'pedir o relatório pagou uma consulta nova');
    const [lista, pdf] = historico;
    assert.equal(lista.searchParams.get('search'), CPF_A);
    assert.equal(lista.searchParams.get('type'), 'CPF');
    assert.equal(lista.searchParams.get('order'), 'createdAt:desc');
    assert.equal(pdf.pathname, '/api/consultations/c-nova/pdf');
    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'contact.teiah_report' }).orderBy('id', 'desc').first());
    assert.deepEqual(JSON.parse(trilha.detail), { mode: 'completo', consultationId: 'c-nova' });
    assert.equal(trilha.detail.includes(CPF_A), false, 'a trilha levou o documento');
  });

  it('o resumo pede o modo resumo', async () => {
    const res = await relatorio('R-100', 'resumo');
    assert.equal(await res.text(), '%PDF-1.4 relatorio c-nova resumo');
  });

  it('quem nunca foi consultado na TeiaH recebe teiah_report_none', async () => {
    await addContract('R-200', 'Sem Consulta', CPF_D);
    const res = await relatorio('R-200');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'teiah_report_none');
  });

  it('quem não tem teiah.act não abre o relatório', async () => {
    const SENHA_DO_TECNICO = ['senha', 'do', 'tecnico', 'relatorio', '1'].join('-');
    const created = await call(`${panelUrl}/api/users`, {
      method: 'POST', ...auth(),
      body: { username: 'tecnico-relatorio', password: SENHA_DO_TECNICO, email: 'tecnico-relatorio@exemplo.test', role: 'tech' }
    });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const login = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: { username: 'tecnico-relatorio', password: SENHA_DO_TECNICO } });
    const res = await call(`${panelUrl}/api/contacts/R-100/teiah/report`, { headers: authHeaders(login.body.data.token) });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'missing_permission');
  });

  it('consulta sem dados para imprimir recebe teiah_report_empty', async () => {
    await addContract('R-300', 'Sem Dados', CPF_C);
    const res = await relatorio('R-300');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, 'teiah_report_empty');
  });
});

describe('consulta de endereço no Novo cliente', () => {
  const ENDERECO = { zip: '68180-430', street: 'Rua Riomar Tapajós', number: '398', district: 'Bela Vista', complement: '' };
  const consultar = (body) => call(`${panelUrl}/api/contacts/lookup/address`, { method: 'POST', ...auth(), body });

  it('manda CEP, rua e número e traz o score, o risco e as dívidas', async () => {
    enderecosConsultados.length = 0;
    const res = await consultar({ address: ENDERECO });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(enderecosConsultados, [{ cep: '68180-430', logradouro: 'Rua Riomar Tapajós', numero: '398', bairro: 'Bela Vista' }]);
    const { result, cached } = res.body.data;
    assert.equal(cached, false);
    assert.equal(result.found, true);
    assert.equal(result.score, 420);
    assert.equal(result.risk, 'ALTO');
    assert.equal(result.debtCount, 2);
    assert.equal(result.debtAmount, 200);
    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'contact.teiah_address' }).orderBy('id', 'desc').first());
    assert.deepEqual(JSON.parse(trilha.detail), { found: true, cached: false });
    assert.equal(trilha.detail.includes('68180'), false, 'a trilha levou o CEP');
  });

  it('o mesmo endereço não é pago de novo; fresh consulta outra vez', async () => {
    enderecosConsultados.length = 0;
    const repetida = await consultar({ address: { ...ENDERECO, number: ' 398 ' } });
    assert.equal(repetida.body.data.cached, true);
    assert.deepEqual(enderecosConsultados, []);
    const nova = await consultar({ address: ENDERECO, fresh: true });
    assert.equal(nova.body.data.cached, false);
    assert.equal(enderecosConsultados.length, 1);
  });

  it('um endereço sem registro volta como não encontrado', async () => {
    const res = await consultar({ address: { ...ENDERECO, zip: '68180-000' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.result.found, false);
    assert.equal(res.body.data.result.message, 'Nenhum registro para este endereço');
  });

  it('endereço incompleto não chega à TeiaH', async () => {
    enderecosConsultados.length = 0;
    for (const address of [{ ...ENDERECO, zip: '6818' }, { ...ENDERECO, number: '' }, { ...ENDERECO, street: 'RUA' }]) {
      const res = await consultar({ address });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.code, 'address_incomplete');
    }
    assert.deepEqual(enderecosConsultados, []);
  });

  it('o relatório vem do histórico, da consulta deste CEP e número', async () => {
    historico.length = 0;
    const res = await fetch(`${panelUrl}/api/contacts/lookup/address/report?cep=68180-430&number=398&mode=resumo`, auth());
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(await res.text(), '%PDF-1.4 relatorio e-certo resumo');
    assert.match(res.headers.get('content-disposition'), /teiah-endereco-68180430-resumo\.pdf/);
    assert.equal(historico[0].searchParams.get('type'), 'ENDERECO');
    assert.equal(historico[0].searchParams.get('search'), '68180430');
    const semConsulta = await fetch(`${panelUrl}/api/contacts/lookup/address/report?cep=68180430&number=12`, auth());
    assert.equal(semConsulta.status, 404);
    assert.equal((await semConsulta.json()).code, 'teiah_report_none');
  });

  it('quem não tem teiah.act não consulta o endereço', async () => {
    const SENHA_DO_TECNICO = ['senha', 'do', 'tecnico', 'endereco', '1'].join('-');
    const created = await call(`${panelUrl}/api/users`, {
      method: 'POST', ...auth(),
      body: { username: 'tecnico-endereco', password: SENHA_DO_TECNICO, email: 'tecnico-endereco@exemplo.test', role: 'tech' }
    });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const login = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: { username: 'tecnico-endereco', password: SENHA_DO_TECNICO } });
    const res = await call(`${panelUrl}/api/contacts/lookup/address`, { method: 'POST', headers: authHeaders(login.body.data.token), body: { address: ENDERECO } });
    assert.equal(res.status, 403);
  });
});

describe('funções de administrador: limite, piora do risco e reconsulta', () => {
  // A senha do dono, a mesma do setup lá em cima, montada para o gitleaks.
  const SENHA_ADMIN = ['operator', 'password', '1'].join('-');
  const SENHA_ERRADA = ['nao', 'e', 'esta'].join('-');
  const CPF_PIORA = '24681357928';
  const CPF_ANTIGO = '13579246828';
  const guardas = (body) => call(`${panelUrl}/api/teiah/guards`, { method: 'PUT', ...auth(), body });
  let tokenTecnico;

  before(async () => {
    RESPOSTAS[CPF_PIORA] = { resultado: { mix: { pessoa: { data: { nome: 'PEDRO PIORA' } }, score: { data: { risco: 'BAIXO', score: 800 } } } } };
    RESPOSTAS[CPF_ANTIGO] = { resultado: { mix: { pessoa: { data: { nome: 'OTO ANTIGO' } }, score: { data: { risco: 'MÉDIO', score: 500 } } } } };
    const SENHA_DO_TECNICO = ['senha', 'do', 'tecnico', 'guardas', '1'].join('-');
    await call(`${panelUrl}/api/users`, {
      method: 'POST', ...auth(),
      body: { username: 'tecnico-guardas', password: SENHA_DO_TECNICO, email: 'tecnico-guardas@exemplo.test', role: 'tech' }
    });
    const login = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: { username: 'tecnico-guardas', password: SENHA_DO_TECNICO } });
    tokenTecnico = login.body.data.token;
  });

  after(async () => {
    await asTenant(() => TeiahService.saveGuards({ monthlyLimit: null, alertWorsening: false }));
  });

  it('só administrador vê e muda as guardas', async () => {
    const tecnico = { headers: authHeaders(tokenTecnico) };
    for (const [path, method] of [['guards', 'GET'], ['guards', 'PUT'], ['worsened', 'GET'], ['reconsult/preview', 'GET'], ['reconsult/run', 'POST'], ['consultations/export', 'POST']]) {
      const res = await call(`${panelUrl}/api/teiah/${path}`, { method, ...tecnico, ...(method === 'GET' ? {} : { body: { password: SENHA_ADMIN } }) });
      assert.equal(res.status, 403, `${method} ${path}`);
    }
    const lido = await call(`${panelUrl}/api/teiah/guards`, auth());
    assert.equal(lido.status, 200, JSON.stringify(lido.body));
    assert.equal(lido.body.data.guards.monthlyLimit, null);
    assert.ok(lido.body.data.usage.count >= 1, 'as consultas pagas acima contaram');
  });

  it('mudar as guardas pede a senha de quem muda', async () => {
    const sem = await guardas({ monthlyLimit: 100 });
    assert.equal(sem.status, 400);
    assert.equal(sem.body.code, 'password_required');
    const errada = await guardas({ monthlyLimit: 100, password: SENHA_ERRADA });
    assert.equal(errada.status, 403);
    assert.equal(errada.body.code, 'password_incorrect');
    const invalida = await guardas({ priceCpf: -1, password: SENHA_ADMIN });
    assert.equal(invalida.status, 400);
    assert.equal(invalida.body.code, 'invalid_guard');
    const certa = await guardas({ monthlyLimit: 100, priceCpf: 5, alertWorsening: true, password: SENHA_ADMIN });
    assert.equal(certa.status, 200, JSON.stringify(certa.body));
    assert.equal(certa.body.data.guards.monthlyLimit, 100);
    assert.equal(certa.body.data.guards.priceCpf, 5);
    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'teiah.guards_changed' }));
    assert.equal(trilha.length, 1);
    assert.equal(trilha[0].detail.includes(SENHA_ADMIN), false);
  });

  it('a piora do risco fica na trilha e na lista dos administradores', async () => {
    await addContract('P-1', 'Pedro Piora', CPF_PIORA);
    const primeira = await call(`${panelUrl}/api/contacts/P-1/teiah`, { method: 'POST', ...auth(), body: { fresh: true } });
    assert.equal(primeira.status, 200, JSON.stringify(primeira.body));
    assert.equal(primeira.body.data.worsened, null);
    RESPOSTAS[CPF_PIORA].resultado.mix.score.data = { risco: 'ALTO', score: 300 };
    const segunda = await call(`${panelUrl}/api/contacts/P-1/teiah`, { method: 'POST', ...auth(), body: { fresh: true } });
    assert.deepEqual(segunda.body.data.worsened, { from: 'BAIXO', to: 'ALTO' });
    const lista = await call(`${panelUrl}/api/teiah/worsened`, auth());
    assert.equal(lista.status, 200);
    assert.equal(lista.body.data.items[0].key, 'P-1');
    assert.equal(lista.body.data.items[0].name, 'Pedro Piora');
    assert.equal(lista.body.data.items[0].to, 'ALTO');
    // Melhorar não é piorar.
    RESPOSTAS[CPF_PIORA].resultado.mix.score.data = { risco: 'BAIXO', score: 900 };
    const terceira = await call(`${panelUrl}/api/contacts/P-1/teiah`, { method: 'POST', ...auth(), body: { fresh: true } });
    assert.equal(terceira.body.data.worsened, null);
  });

  it('reconsultar os antigos: prévia com custo, e rodar pede a senha', async () => {
    await addContract('O-1', 'Oto Antigo', CPF_ANTIGO);
    await call(`${panelUrl}/api/contacts/O-1/teiah`, { method: 'POST', ...auth(), body: { fresh: true } });
    // A consulta envelhece: oito meses atrás.
    await asTenant(async () => {
      const db = getDb();
      const row = await db('sgp_clients').where({ document: CPF_ANTIGO }).first();
      const teiah = typeof row.teiah === 'string' ? JSON.parse(row.teiah) : row.teiah;
      teiah.consultedAt = new Date(Date.now() - 240 * 86_400_000).toISOString();
      await db('sgp_clients').where({ id: row.id }).update({ teiah: JSON.stringify(teiah) });
    });
    const previa = await call(`${panelUrl}/api/teiah/reconsult/preview`, auth());
    assert.equal(previa.status, 200, JSON.stringify(previa.body));
    assert.equal(previa.body.data.count, 1);
    assert.equal(previa.body.data.estimatedCost, 5);
    assert.equal(previa.body.data.sample[0].name, 'Oto Antigo');

    consultas.length = 0;
    const sem = await call(`${panelUrl}/api/teiah/reconsult/run`, { method: 'POST', ...auth(), body: {} });
    assert.equal(sem.status, 400);
    assert.equal(sem.body.code, 'password_required');
    assert.deepEqual(consultas, []);
    const roda = await call(`${panelUrl}/api/teiah/reconsult/run`, { method: 'POST', ...auth(), body: { password: SENHA_ADMIN } });
    assert.equal(roda.status, 200, JSON.stringify(roda.body));
    assert.equal(roda.body.data.processed, 1);
    assert.deepEqual(consultas, [CPF_ANTIGO]);
    const depois = await call(`${panelUrl}/api/teiah/reconsult/preview`, auth());
    assert.equal(depois.body.data.count, 0, 'consultado agora, não é mais antigo');
  });

  it('o selo de risco da conversa vem do que o painel guardou', async () => {
    const { default: WaSubscriberPanelService } = await import('../src/services/waSubscriberPanelService.js');
    const selo = await asTenant(() => WaSubscriberPanelService.teiahBadge(CPF_PIORA));
    assert.equal(selo.risk, 'BAIXO');
    assert.equal(selo.score, 900);
    assert.equal(await asTenant(() => WaSubscriberPanelService.teiahBadge('00000000000')), null);
  });

  it('passado o limite do mês, só o administrador com a senha consulta', async () => {
    await guardas({ monthlyLimit: 1, password: SENHA_ADMIN });
    consultas.length = 0;
    const barrada = await call(`${panelUrl}/api/contacts/P-1/teiah`, { method: 'POST', ...auth(), body: { fresh: true } });
    assert.equal(barrada.status, 409, JSON.stringify(barrada.body));
    assert.equal(barrada.body.code, 'teiah_limit_reached');
    assert.deepEqual(consultas, [], 'nada foi pago');

    const errada = await call(`${panelUrl}/api/contacts/P-1/teiah`, { method: 'POST', ...auth(), body: { fresh: true, limitPassword: SENHA_ERRADA } });
    assert.equal(errada.status, 403);
    assert.equal(errada.body.code, 'password_incorrect');

    const liberada = await call(`${panelUrl}/api/contacts/P-1/teiah`, { method: 'POST', ...auth(), body: { fresh: true, limitPassword: SENHA_ADMIN } });
    assert.equal(liberada.status, 200, JSON.stringify(liberada.body));
    assert.deepEqual(consultas, [CPF_PIORA]);

    const endereco = await call(`${panelUrl}/api/contacts/lookup/address`, {
      method: 'POST', ...auth(), body: { fresh: true, address: { zip: '68180-430', street: 'RUA DO LIMITE', number: '7', district: 'CENTRO' } }
    });
    assert.equal(endereco.status, 409, JSON.stringify(endereco.body));
    assert.equal(endereco.body.code, 'teiah_limit_reached');

    const trilha = await asTenant(() => getDb()('audit_log').where({ action: 'teiah.limit_overridden' }));
    assert.equal(trilha.length, 1);

    // A reconsulta em lote não passa do limite: para.
    await asTenant(async () => {
      const db = getDb();
      const row = await db('sgp_clients').where({ document: CPF_ANTIGO }).first();
      const teiah = typeof row.teiah === 'string' ? JSON.parse(row.teiah) : row.teiah;
      teiah.consultedAt = '2025-01-01T00:00:00.000Z';
      await db('sgp_clients').where({ id: row.id }).update({ teiah: JSON.stringify(teiah) });
    });
    const lote = await call(`${panelUrl}/api/teiah/reconsult/run`, { method: 'POST', ...auth(), body: { password: SENHA_ADMIN } });
    assert.equal(lote.status, 200, JSON.stringify(lote.body));
    assert.equal(lote.body.data.stoppedByLimit, true);
    assert.equal(lote.body.data.processed, 0);
  });
});
