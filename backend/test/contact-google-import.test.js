import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

/**
 * Importar os contatos exportados do Google Contatos (Gmail): o CSV do Google,
 * o CSV do Outlook e o vCard. Só entra quem o painel ainda não conhece, e nada
 * existente é alterado — a mesma regra da agenda do WhatsApp.
 */

let panelUrl;
let token;

const importar = (text, mode) => fetch(`${panelUrl}/api/contacts/import?mode=${mode}`, {
  method: 'POST',
  headers: { ...authHeaders(token), 'Content-Type': 'text/csv' },
  body: text
}).then(async (res) => ({ status: res.status, body: await res.json() }));

const GOOGLE_CSV = [
  'First Name,Middle Name,Last Name,Nickname,Birthday,Notes,Labels,E-mail 1 - Label,E-mail 1 - Value,Phone 1 - Label,Phone 1 - Value,Phone 2 - Label,Phone 2 - Value,Address 1 - Label,Address 1 - Formatted,Address 1 - Street,Address 1 - City,Address 1 - Region,Address 1 - Postal Code',
  'Carla,,Gmail,,1990-05-14,Cliente antiga,* myContacts,* Home,carla@exemplo.test ::: carla.trab@exemplo.test,Mobile,(93) 99222-0001 ::: (93) 3522-0001,,,Home,"Rua A, 10",Rua A 10,Santarém,PA,68000-000',
  // O João do contrato 301, sem o nono dígito: já existe, é pulado.
  'João,,Repetido,,,,,,,Mobile,(93) 9111-0002,,,,,,,,',
  'Sem,,Telefone,,,,,* Home,sem@exemplo.test,,,,,,,,,,',
  // A Carla de novo, no mesmo arquivo.
  'Carla,,Duplicada,,,,,,,Mobile,+55 93 99222-0001,,,,,,,,'
].join('\r\n');

const GOOGLE_CSV_ANTIGO = [
  'Name,Given Name,Additional Name,Family Name,Group Membership,E-mail 1 - Type,E-mail 1 - Value,Phone 1 - Type,Phone 1 - Value',
  'Davi Antigo,Davi,,Antigo,* myContacts,* Home,davi@exemplo.test,Mobile,93992220002'
].join('\n');

const OUTLOOK_CSV = [
  'First Name,Middle Name,Last Name,E-mail Address,Mobile Phone,Home Phone',
  'Eva,,Outlook,eva@exemplo.test,(93) 99222-0003,'
].join('\n');

const VCARD = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Fábio vCard',
  'N:vCard;Fábio;;;',
  'item1.TEL;TYPE=CELL:+55 93 99222-0004',
  'TEL;TYPE=HOME:(93) 3522-0004',
  'EMAIL;TYPE=INTERNET:fabio@exemplo.test',
  'NOTE:Linha um\\nlinha dois',
  'END:VCARD'
].join('\r\n');

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await getDb()('sgp_contacts').insert([
    { tenant_id: 1, contract: '301', client_name: 'JOÃO', phone_e164: '5593991110002', state: 'active' }
  ]);
});

after(async () => {
  await stopTestServers();
});

const importados = () => getDb()('sgp_contacts').where({ import_source: 'google' }).orderBy('id');

describe('CSV do Google', () => {
  it('a prévia conta novos, existentes, sem telefone e duplicados, sem gravar nada', async () => {
    const res = await importar(GOOGLE_CSV, 'preview');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const data = res.body.data;
    assert.equal(data.format, 'google');
    assert.equal(data.total, 4);
    assert.equal(data.creates, 1);
    assert.equal(data.existing, 1);
    assert.equal(data.invalid, 1);
    assert.equal(data.duplicated, 1);
    assert.deepEqual(data.rows, [{ name: 'Carla Gmail', phone: '5593992220001' }]);
    assert.equal((await importados()).length, 0, 'a prévia não grava');
  });

  it('aplicar cria o cliente com WhatsApp, telefones, e-mails e endereço, marcado como do Google', async () => {
    const res = await importar(GOOGLE_CSV, 'apply');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.created, 1);
    const [linha] = await importados();
    assert.equal(linha.client_name, 'Carla Gmail');
    assert.equal(linha.phone_e164, '5593992220001');

    const ficha = await call(`${panelUrl}/api/contacts/c:${linha.id}`, { headers: authHeaders(token) });
    const campos = ficha.body.data.fields;
    assert.deepEqual(campos.phones.value, ['5593992220001', '559335220001']);
    assert.deepEqual(campos.emails.value, ['carla@exemplo.test', 'carla.trab@exemplo.test']);
    assert.equal(campos.birthDate.value, '1990-05-14');
    assert.equal(campos.address.value.city, 'Santarém');
    assert.equal(ficha.body.data.notes, 'Cliente antiga');

    const trilha = await getDb()('audit_log').where({ action: 'contacts.imported' }).orderBy('id', 'desc').first();
    assert.match(String(trilha.detail), /google/);
  });

  it('importar o mesmo arquivo de novo não cria ninguém', async () => {
    const res = await importar(GOOGLE_CSV, 'preview');
    assert.equal(res.body.data.creates, 0);
    assert.equal(res.body.data.existing, 3);
  });
});

describe('outros formatos do Google Contatos', () => {
  it('o CSV antigo do Google', async () => {
    const res = await importar(GOOGLE_CSV_ANTIGO, 'apply');
    assert.equal(res.body.data.format, 'google');
    assert.equal(res.body.data.created, 1);
    assert.ok((await importados()).some((linha) => linha.client_name === 'Davi Antigo'));
  });

  it('o CSV do Outlook', async () => {
    const res = await importar(OUTLOOK_CSV, 'apply');
    assert.equal(res.body.data.format, 'outlook');
    assert.equal(res.body.data.created, 1);
    assert.ok((await importados()).some((linha) => linha.client_name === 'Eva Outlook' && linha.phone_e164 === '5593992220003'));
  });

  it('o vCard, com o celular como WhatsApp', async () => {
    const res = await importar(VCARD, 'apply');
    assert.equal(res.body.data.format, 'vcard');
    assert.equal(res.body.data.created, 1);
    const linha = (await importados()).find((entry) => entry.client_name === 'Fábio vCard');
    assert.ok(linha);
    assert.equal(linha.phone_e164, '5593992220004');
  });
});

describe('a planilha do próprio painel', () => {
  it('continua indo para o importador da planilha', async () => {
    const res = await importar('Nome;WhatsApp\r\nCliente da Planilha;(93) 99222-0009', 'preview');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.format, undefined);
    assert.equal(res.body.data.creates, 1);
  });
});
