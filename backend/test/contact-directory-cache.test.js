import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, getDb, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaContactService } = await import('../src/services/waContactService.js');
const { default: SgpLink } = await import('../src/models/SgpLink.js');
const { default: SgpContact } = await import('../src/models/SgpContact.js');
const { default: SgpClient } = await import('../src/models/SgpClient.js');
const { tinsert } = await import('../src/config/database.js');
const { writesContactDirectory, contactDirectoryCache } = await import('../src/config/contactDirectoryCache.js');

/**
 * A memória de `WaContactService.gather`: a mesma lista por trinta segundos, e
 * esquecida por QUALQUER escrita nas tabelas que ela lê — pelo modelo, por um
 * `tdb` solto, por uma fixture direto no banco — e só para o provedor que
 * escreveu.
 */
let alfa;
let beta;

const nomes = async (tenantId, search = '') => (await runInTenant(tenantId, () => WaContactService.gather({ search })))
  .map((s) => s.clientName);

before(async () => {
  await startTestServers();
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  await db('tenants').insert({ slug: 'beta-contatos', name: 'Beta Contatos', status: 'active' });
  beta = (await db('tenants').where({ slug: 'beta-contatos' }).first()).id;
});
after(stopTestServers);

beforeEach(async () => {
  for (const table of ['sgp_links', 'sgp_contacts', 'sgp_clients']) {
    // eslint-disable-next-line no-await-in-loop -- três tabelas
    await getDb()(table).del();
  }
  contactDirectoryCache.clear();
});

describe('a memória da lista de contatos', () => {
  it('serve a mesma promessa para a mesma busca, e uma por busca', async () => {
    const [a, b] = await runInTenant(alfa, () => Promise.all([WaContactService.gather({}), WaContactService.gather({})]));
    assert.equal(a, b);
    const outra = await runInTenant(alfa, () => WaContactService.gather({ search: 'x' }));
    assert.notEqual(outra, a);
  });

  it('o upsert do modelo invalida', async () => {
    assert.deepEqual(await nomes(alfa), []);
    await runInTenant(alfa, () => SgpLink.upsert({ device_id: 'ONT-1', contract: '100', client_name: 'Ana', state: 'active' }));
    assert.deepEqual(await nomes(alfa), ['Ana']);
  });

  it('a escrita direta no banco (fixture, tdb solto) também', async () => {
    assert.deepEqual(await nomes(alfa), []);
    await getDb()('sgp_contacts').insert({ tenant_id: alfa, contract: '200', client_name: 'Bia' });
    assert.deepEqual(await nomes(alfa), ['Bia']);
    await getDb()('sgp_contacts').where({ contract: '200' }).update({ client_name: 'Bianca' });
    assert.deepEqual(await nomes(alfa), ['Bianca']);
    await getDb()('sgp_contacts').where({ contract: '200' }).del();
    assert.deepEqual(await nomes(alfa), []);
  });

  it('editar o telefone e a ficha invalida', async () => {
    await asTenant(() => tinsert('sgp_contacts', { contract: '300', client_name: 'Caio' }));
    const antes = await runInTenant(alfa, () => WaContactService.gather({}));
    assert.equal(antes[0].phone, null);
    await runInTenant(alfa, () => SgpContact.setManualPhone('300', '5593981110300'));
    const depois = await runInTenant(alfa, () => WaContactService.gather({}));
    assert.equal(depois[0].phone, '5593981110300');

    const cliente = await runInTenant(alfa, () => SgpClient.createFromPanel({ overrides: {} }));
    const lista = await runInTenant(alfa, () => WaContactService.gather({}));
    await runInTenant(alfa, () => SgpClient.setTeiah(cliente.id, { score: { risk: 'ALTO' } }));
    assert.notEqual(await runInTenant(alfa, () => WaContactService.gather({})), lista);
  });

  it('a escrita de um provedor não esquece a lista do outro', async () => {
    await nomes(alfa);
    const doBeta = await runInTenant(beta, () => WaContactService.gather({}));
    await runInTenant(alfa, () => tinsert('sgp_contacts', { contract: '400', client_name: 'Duda' }));
    assert.deepEqual(await nomes(alfa), ['Duda']);
    assert.equal(await runInTenant(beta, () => WaContactService.gather({})), doBeta, 'a do beta continua na memória');
  });

  it('ordena pelo nome em pt-BR como antes', async () => {
    for (const [contract, name] of [['1', 'Élio'], ['2', 'eduardo'], ['3', 'Zé'], ['4', 'álvaro'], ['5', 'Bruno']]) {
      // eslint-disable-next-line no-await-in-loop -- cinco linhas
      await asTenant(() => tinsert('sgp_contacts', { contract, client_name: name }));
    }
    const esperado = ['Élio', 'eduardo', 'Zé', 'álvaro', 'Bruno']
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
    assert.deepEqual(await nomes(alfa), esperado);
  });
});

describe('o reconhecimento da escrita', () => {
  it('pega INSERT, UPDATE e DELETE nas quatro tabelas, nos três dialetos', () => {
    for (const sql of [
      'insert into "sgp_links" ("a") values (1)',
      'update `sgp_contacts` set `x` = 1',
      'delete from sgp_clients where id = 1',
      'insert into "asaas_customers" select 1 where true on conflict do nothing',
      'insert ignore into `sgp_links` values (1)'
    ]) assert.ok(writesContactDirectory(sql), sql);
  });

  it('ignora leitura e tabela de nome parecido', () => {
    for (const sql of [
      'select * from "sgp_links"',
      'update "sgp_links_archive" set a = 1',
      'insert into "wa_conversations" ("sgp_contact_id") values (1)',
      null
    ]) assert.ok(!writesContactDirectory(sql), String(sql));
  });
});
