import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: ContactSheetService, SheetLookup } = await import('../src/services/contactSheetService.js');
const { tinsert } = await import('../src/config/database.js');

/**
 * A prévia da importação lê as fichas em lote (`SheetLookup`) em vez de cinco
 * a oito consultas por linha. O que importa provar é que ela responde
 * EXATAMENTE o que a leitura linha a linha respondia — o mesmo registro
 * achado, os mesmos campos mudados, o mesmo erro — em todos os caminhos de
 * `findRow`: pela chave `c:<id>`, pelo contrato (com e sem linha de contato,
 * com mais de uma ONT), pelo CPF/CNPJ da ficha e pelo da linha de contato, e
 * os que não acham ninguém.
 */
const now = new Date();
let semContratoId;

before(async () => {
  await startTestServers();
  await asTenant(async () => {
    // Ficha do SGP com dois contratos e uma edição do operador no nome.
    await tinsert('sgp_clients', {
      sgp_client_id: '70', source: 'sgp', name: 'Elane SGP', document: '12345678909',
      phones: JSON.stringify(['5593991261076']), emails: JSON.stringify(['elane@exemplo.test']),
      overrides: JSON.stringify({ name: { value: 'Elane Editada', by: 'op', at: now.toISOString() } }),
      notes: 'prefere à tarde', updated_at: now
    });
    await tinsert('sgp_contacts', { contract: '373', client_ref: '70', client_name: 'Elane SGP', document: '12345678909', phone_e164: '5593991261076', state: 'active' });
    await tinsert('sgp_contacts', { contract: '374', client_ref: '70', client_name: 'Elane SGP', document: '12345678909', state: 'blocked' });
    // Duas ONTs no 373: o WhatsApp da ficha não muda por isso.
    await tinsert('sgp_links', { device_id: 'ONT-373-A', contract: '373', client_name: 'Elane SGP', phone_manual: '5593981110373', state: 'active' });
    await tinsert('sgp_links', { device_id: 'ONT-373-B', contract: '373', client_name: 'Elane SGP', phone_e164: '5593981119999', state: 'active' });
    // Contrato com ONT e sem linha de contato: a ficha nasce da ONT.
    await tinsert('sgp_links', { device_id: 'ONT-500', contract: '500', client_name: 'Só ONT', document: '52998224725', phone_e164: '5593981110500', state: 'active' });
    // Cliente sem contrato, só com a linha dele.
    await tinsert('sgp_clients', { sgp_client_id: 'panel:abc', source: 'panel', overrides: JSON.stringify({}), updated_at: now });
    await tinsert('sgp_contacts', { contract: null, sgp_client_id: 'panel:abc', client_ref: 'panel:abc', client_name: 'Sem Contrato', document: '11222333000181' });
    // Linha de contato achada só pelo documento, sem ficha.
    await tinsert('sgp_contacts', { contract: '600', client_name: 'Só Documento', document: '39053344705', state: 'active' });
  });
  semContratoId = (await getDb()('sgp_contacts').where({ sgp_client_id: 'panel:abc' }).first()).id;
});
after(stopTestServers);

const linhas = () => [
  { key: '373', name: 'Elane Editada' },
  { key: '373', name: 'Outro Nome', whatsappPhone: '5593981110001' },
  { contract: ' 374 ', notes: 'nova nota' },
  { contract: '500', name: 'Só ONT', whatsappPhone: '5593981110500' },
  { contract: '500', emails: 'novo@exemplo.test' },
  { key: `c:${semContratoId}`, name: 'Sem Contrato Renomeado' },
  { key: 'c:999999', name: 'Ninguém' },
  { key: 'c:0', name: 'Ninguém' },
  { contract: '9999', name: 'Contrato que não existe' },
  { document: '123.456.789-09', name: 'Elane Editada', notes: 'prefere à tarde' },
  { document: '1234567890', name: 'CPF que o Excel comeu o zero' },
  { document: '39053344705', name: 'Só Documento Novo' },
  { document: '52998224725', name: 'Documento só na ONT' },
  { name: 'Cliente Novo', whatsappPhone: '5593981112222' },
  { name: '' },
  { key: '   ', contract: '373', name: 'chave em branco' },
  { key: '373', document: '9', name: 'documento com verificador errado' }
];

/** O passo de uma linha, ou o erro dela, como a prévia o registraria. */
async function passo(cells, lookup) {
  try {
    return await ContactSheetService.planRow(cells, lookup);
  } catch (error) {
    return { error: error.translationKey ?? error.message, vars: error.translationVars ?? null };
  }
}

describe('a prévia da planilha, lida em lote', () => {
  it('responde linha a linha o mesmo que a leitura avulsa', async () => {
    await asTenant(async () => {
      const cells = linhas();
      const lookup = await SheetLookup.load(cells);
      for (const linha of cells) {
        // eslint-disable-next-line no-await-in-loop -- comparação linha a linha
        const avulsa = await passo(linha, null);
        // eslint-disable-next-line no-await-in-loop -- idem
        const emLote = await passo(linha, lookup);
        assert.deepEqual(emLote, avulsa, JSON.stringify(linha));
      }
    });
  });

  it('e a prévia inteira bate com a soma das linhas avulsas', async () => {
    const header = ['Chave', 'Contrato', 'Nome', 'CPF/CNPJ', 'WhatsApp', 'E-mails', 'Observações'];
    const fields = ['key', 'contract', 'name', 'document', 'whatsappPhone', 'emails', 'notes'];
    // A linha toda vazia o leitor de CSV descarta antes de planejar.
    const comConteudo = linhas().filter((l) => Object.values(l).some((v) => String(v).trim()));
    const csv = [header.join(';'), ...comConteudo.map((l) => fields.map((f) => l[f] ?? '').join(';'))].join('\n');
    const plano = await asTenant(() => ContactSheetService.plan(csv));
    assert.equal(plano.total, comConteudo.length);
    // As contas da prévia, refeitas pelo caminho avulso.
    let updates = 0;
    let errors = 0;
    for (const linha of comConteudo) {
      // Aparadas como `unescapeCell` as entrega.
      const cells = Object.fromEntries(fields.map((f) => [f, String(linha[f] ?? '').trim()]));
      // eslint-disable-next-line no-await-in-loop -- comparação
      const p = await asTenant(() => passo(cells, null));
      if (p.error) errors += 1;
      else if (p.kind === 'update' && p.changed.length) updates += 1;
    }
    assert.equal(plano.updates.length, updates);
    assert.equal(plano.errors.length, errors);
    assert.ok(plano.updates.length > 0 && plano.errors.length > 0 && plano.creates.length > 0, JSON.stringify(plano));
  });
});
