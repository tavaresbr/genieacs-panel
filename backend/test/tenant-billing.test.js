import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  authHeaders, call, getDb, runInTenant, startTestServers, stopTestServers
} from './helpers/harness.js';

const { default: Tenant } = await import('../src/models/Tenant.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');
const { default: TenantExportService } = await import('../src/services/tenantExportService.js');
const { mapBrasilApiCnpj } = await import('../src/services/cnpjLookupService.js');
const { normalizeTaxId, isValidTaxId, isValidCpf, isValidCnpj } = await import(
  '../src/utils/taxId.js'
);

/**
 * O cadastro fiscal do provedor.
 *
 * `tenants` nasceu com slug, nome e situação — o bastante para resolver um host
 * e para ligar e desligar um cliente. Faturar exige outra coisa: razão social,
 * CNPJ, endereço e alguém que receba a cobrança. Sem isso o cadastro de um
 * provedor não serve de contrato, e a nota não sai.
 *
 * O que este arquivo guarda são as três maneiras de errar isto: aceitar um
 * documento que não existe (e descobrir no dia da emissão), deixar um provedor
 * ler ou escrever o cadastro do vizinho, e esquecer o cadastro fora do arquivo
 * que o provedor leva quando sai.
 */
let panelUrl;
let token;
let meu;

const CNPJ_BOM = '11222333000181';
const CPF_BOM = '52998224725';

const FISCAL = {
  legalName: 'Provedor Alfa Telecomunicações LTDA',
  taxId: '11.222.333/0001-81',
  stateRegistration: 'ISENTO',
  postalCode: '01310-100',
  addressLine: 'Avenida Paulista',
  addressNumber: '1000',
  addressExtra: 'Sala 12',
  district: 'Bela Vista',
  city: 'São Paulo',
  state: 'sp',
  email: 'financeiro@alfa.test',
  phone: '+55 11 99999-0000'
};

const patch = (body, headers = authHeaders(token)) =>
  call(`${panelUrl}/api/tenant`, { method: 'PATCH', headers, body });

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'a-dona', password: 'senha-da-dona-1', email: 'a-dona@exemplo.test' }
  });
  token = setup.body.data.token;
  meu = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
});

after(async () => {
  await stopTestServers();
});

beforeEach(async () => {
  const limpo = {};
  for (const coluna of Tenant.BILLING_COLUMNS) limpo[coluna] = null;
  await getDb()('tenants').where({ id: meu }).update(limpo);
  await getDb()('audit_log').where({ tenant_id: meu }).del();
});

describe('o documento é conferido, não só medido', () => {
  it('aceita CNPJ e CPF de verdade, com ou sem pontuação', () => {
    assert.ok(isValidCnpj(CNPJ_BOM));
    assert.ok(isValidCpf(CPF_BOM));
    assert.ok(isValidTaxId('11.222.333/0001-81'));
    assert.ok(isValidTaxId('529.982.247-25'));
  });

  /**
   * A transposição de dois dígitos é o erro de digitação mais comum, e é
   * exatamente o que a conferência de TAMANHO não vê. É por ele que existe
   * aritmética aqui em vez de um `length === 14`.
   */
  it('recusa o documento do tamanho certo com um dígito trocado', () => {
    assert.equal(isValidTaxId('11222333000182'), false);
    assert.equal(isValidTaxId('52998224726'), false);
  });

  it('recusa a sequência repetida, que passa na conta e não existe no mundo', () => {
    assert.equal(isValidTaxId('11111111111'), false);
    assert.equal(isValidTaxId('11111111111111'), false);
  });

  it('e guarda só dígitos, que é como se compara', () => {
    assert.equal(normalizeTaxId('11.222.333/0001-81'), CNPJ_BOM);
    assert.equal(normalizeTaxId(null), '');
  });
});

describe('o cadastro entra pela tela do provedor', () => {
  it('grava tudo, normalizando o que o banco guarda sem enfeite', async () => {
    const salvo = await patch({ billing: FISCAL });
    assert.equal(salvo.status, 200);

    const linha = await getDb()('tenants').where({ id: meu }).first();
    assert.equal(linha.billing_legal_name, FISCAL.legalName);
    // Documento e CEP sem pontuação; a UF em maiúsculas.
    assert.equal(linha.billing_tax_id, CNPJ_BOM);
    assert.equal(linha.billing_postal_code, '01310100');
    assert.equal(linha.billing_state, 'SP');
    assert.equal(linha.billing_email, 'financeiro@alfa.test');
  });

  it('e devolve o cadastro em camelCase, que é o que a tela lê', async () => {
    const salvo = await patch({ billing: FISCAL });
    assert.equal(salvo.body.data.billing.legalName, FISCAL.legalName);
    assert.equal(salvo.body.data.billing.taxId, CNPJ_BOM);
    assert.equal(salvo.body.data.billing.state, 'SP');
  });

  /**
   * Campo ausente não é tocado; campo presente e vazio vira nulo. A diferença
   * entre os dois é o contrato inteiro desta rota: sem ela, salvar o endereço
   * apagaria o CNPJ, e apagar um dado preenchido por engano seria impossível.
   */
  it('não apaga o que não veio no corpo', async () => {
    await patch({ billing: FISCAL });
    await patch({ billing: { city: 'Campinas' } });
    const linha = await getDb()('tenants').where({ id: meu }).first();
    assert.equal(linha.billing_city, 'Campinas');
    assert.equal(linha.billing_tax_id, CNPJ_BOM, 'o documento não podia ter sumido');
  });

  it('e apaga o que veio vazio', async () => {
    await patch({ billing: FISCAL });
    await patch({ billing: { stateRegistration: '' } });
    const linha = await getDb()('tenants').where({ id: meu }).first();
    assert.equal(linha.billing_state_registration, null);
  });

  it('recusa o documento inválido sem gravar nada', async () => {
    const recusa = await patch({ billing: { ...FISCAL, taxId: '11222333000182' } });
    assert.equal(recusa.status, 400);
    const linha = await getDb()('tenants').where({ id: meu }).first();
    assert.equal(linha.billing_legal_name, null, 'uma recusa não pode gravar metade');
  });

  it('recusa CEP curto e e-mail de cobrança inválido', async () => {
    assert.equal((await patch({ billing: { postalCode: '1234' } })).status, 400);
    assert.equal((await patch({ billing: { email: 'nao-e-email' } })).status, 400);
  });

  it('e continua renomeando o provedor, que era o que a rota fazia antes', async () => {
    const renomeado = await patch({ name: 'Alfa Fibra' });
    assert.equal(renomeado.status, 200);
    assert.equal(renomeado.body.data.name, 'Alfa Fibra');
    const linha = await getDb()('tenants').where({ id: meu }).first();
    assert.equal(linha.name, 'Alfa Fibra');
  });

  it('e recusa o corpo que não pede nada', async () => {
    assert.equal((await patch({})).status, 400);
  });
});

describe('a trilha registra quem mexeu, não o que está escrito', () => {
  it('grava os campos alterados e nenhum valor', async () => {
    await patch({ billing: { legalName: 'Alfa LTDA', taxId: FISCAL.taxId } });
    const linha = await getDb()('audit_log')
      .where({ tenant_id: meu, action: AuditLog.ACTIONS.TENANT_BILLING_CHANGED })
      .first();
    assert.ok(linha, 'a mudança do cadastro fiscal tem que deixar linha');
    const detalhe = JSON.parse(linha.detail);
    assert.deepEqual(detalhe.fields, ['billing_legal_name', 'billing_tax_id']);
    // O ponto do teste: o CNPJ não pode estar em lugar nenhum da linha.
    assert.equal(JSON.stringify(linha).includes(CNPJ_BOM), false);
  });

  it('e não confunde renomear com faturar', async () => {
    await patch({ name: 'Só o nome' });
    const fiscais = await getDb()('audit_log')
      .where({ tenant_id: meu, action: AuditLog.ACTIONS.TENANT_BILLING_CHANGED });
    assert.equal(fiscais.length, 0);
  });
});

describe('o cadastro é do provedor, e sai com ele', () => {
  it('vai no manifesto da exportação', async () => {
    await patch({ billing: FISCAL });
    const arquivo = await runInTenant(meu, () => TenantExportService.build());
    assert.equal(arquivo.manifest.tenant.billing.taxId, CNPJ_BOM);
    assert.equal(arquivo.manifest.tenant.billing.city, 'São Paulo');
  });

  /**
   * `tenants` não é tabela escopada e não entra pelo laço do export. Sem a
   * linha do manifesto, o único dado do arquivo que falaria do dono do arquivo
   * seria o nome — e é o tipo de falta que ninguém nota até precisar.
   */
  it('e é a única porta por onde ele sai, porque a tabela não é escopada', () => {
    assert.equal(TenantExportService.tabelas().includes('tenants'), false);
  });
});

describe('o cadastro fiscal não é público', () => {
  /**
   * A porta pública tem DUAS trancas, e esta prova a de baixo. A de cima — o
   * controlador que escreve campo a campo em vez de espalhar a linha — já é
   * provada em `tenant-public.test.js`, e foi ela que segurou quando testei
   * esta suíte com as colunas fiscais postas na lista pública: o teste abaixo
   * passou mesmo com a tranca de baixo aberta. Sem esta asserção, a lista do
   * modelo poderia apodrecer sem ninguém ver.
   */
  it('nenhuma coluna fiscal está na lista de colunas públicas do modelo', () => {
    const publicas = new Set(Tenant.PUBLIC_COLUMNS);
    for (const coluna of Tenant.BILLING_COLUMNS) {
      assert.equal(publicas.has(coluna), false, `${coluna} não pode ser pública`);
    }
  });

  it('a rota que a tela de login lê não devolve nada dele', async () => {
    await patch({ billing: FISCAL });
    const publico = await call(`${panelUrl}/api/tenant/public`);
    const corpo = JSON.stringify(publico.body);
    assert.equal(corpo.includes(CNPJ_BOM), false);
    assert.equal(corpo.includes('financeiro@alfa.test'), false);
    assert.equal(corpo.includes('Avenida Paulista'), false);
  });

  it('e sem sessão não se escreve nele', async () => {
    const semToken = await call(`${panelUrl}/api/tenant`, {
      method: 'PATCH', body: { billing: FISCAL }
    });
    assert.equal(semToken.status, 401);
  });
});

/**
 * Preencher o cadastro pelo CNPJ.
 *
 * A consulta vai para a BrasilAPI; aqui ela é trocada por uma resposta fixa,
 * deixando passar as chamadas do próprio teste ao painel. O que se prova: o
 * número é conferido antes de gastar a consulta, a resposta volta no formato
 * do cadastro, e nada é gravado — preencher não é salvar.
 */
describe('preencher o cadastro pelo CNPJ', () => {
  const realFetch = globalThis.fetch;
  let consultas;

  const RESPOSTA = {
    cnpj: CNPJ_BOM,
    razao_social: 'PROVEDOR ALFA TELECOMUNICACOES LTDA',
    descricao_tipo_de_logradouro: 'AVENIDA',
    logradouro: 'PAULISTA',
    numero: '1000',
    complemento: 'SALA 12',
    bairro: 'BELA VISTA',
    municipio: 'SAO PAULO',
    uf: 'sp',
    cep: '01310100',
    email: 'Financeiro@Alfa.test',
    ddd_telefone_1: '1133334444'
  };

  const fakeBrasilApi = (status, body) => {
    consultas = [];
    globalThis.fetch = (input, init) => {
      const url = String(input);
      if (url.startsWith('https://brasilapi.com.br/')) {
        consultas.push(url);
        return Promise.resolve(new Response(JSON.stringify(body ?? {}), {
          status, headers: { 'Content-Type': 'application/json' }
        }));
      }
      return realFetch(input, init);
    };
  };

  const lookup = (cnpj, headers = authHeaders(token)) =>
    call(`${panelUrl}/api/tenant/cnpj?cnpj=${encodeURIComponent(cnpj)}`, { headers });

  after(() => { globalThis.fetch = realFetch; });

  it('devolve os dados no formato do cadastro, sem gravar', async () => {
    fakeBrasilApi(200, RESPOSTA);
    const res = await lookup('11.222.333/0001-81');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, {
      taxId: CNPJ_BOM,
      legalName: 'PROVEDOR ALFA TELECOMUNICACOES LTDA',
      postalCode: '01310100',
      addressLine: 'AVENIDA PAULISTA',
      addressNumber: '1000',
      addressExtra: 'SALA 12',
      district: 'BELA VISTA',
      city: 'SAO PAULO',
      state: 'SP',
      email: 'financeiro@alfa.test',
      phone: '1133334444'
    });
    assert.deepEqual(consultas, [`https://brasilapi.com.br/api/cnpj/v1/${CNPJ_BOM}`]);
    const linha = await getDb()('tenants').where({ id: meu }).first();
    assert.equal(linha.billing_tax_id, null);
    assert.equal(linha.billing_legal_name, null);
  });

  it('recusa o que não é CNPJ sem consultar ninguém', async () => {
    fakeBrasilApi(200, RESPOSTA);
    assert.equal((await lookup('11222333000182')).status, 400);
    assert.equal((await lookup(CPF_BOM)).status, 400);
    assert.deepEqual(consultas, []);
  });

  it('404 quando a Receita não conhece; 502 quando a consulta falha', async () => {
    fakeBrasilApi(404, { message: 'not found' });
    assert.equal((await lookup(CNPJ_BOM)).status, 404);
    fakeBrasilApi(500, {});
    assert.equal((await lookup(CNPJ_BOM)).status, 502);
  });

  it('sem sessão não consulta', async () => {
    fakeBrasilApi(200, RESPOSTA);
    assert.equal((await lookup(CNPJ_BOM, {})).status, 401);
    assert.deepEqual(consultas, []);
  });

  it('o que não veio fica de fora, e o que não cabe é cortado', () => {
    const mapeado = mapBrasilApiCnpj({ razao_social: 'X'.repeat(300), cep: 1310100, uf: null, email: '' });
    assert.deepEqual(Object.keys(mapeado).sort(), ['legalName', 'postalCode']);
    assert.equal(mapeado.legalName.length, 160);
    assert.equal(mapeado.postalCode, '01310100');
  });
});
