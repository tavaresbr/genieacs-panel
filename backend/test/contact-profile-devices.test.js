import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: ContactProfileService } = await import('../src/services/contactProfileService.js');
const { default: SgpLink } = await import('../src/models/SgpLink.js');
const { default: SgpContact } = await import('../src/models/SgpContact.js');

/**
 * Um contrato com duas ONTs mostra as duas, e não só a que veio primeiro.
 *
 * A página do contato lia uma ONT por contrato e escondia a segunda: o cliente
 * com dois contratos e duas ONTs presas ao mesmo contrato parecia ter uma só
 * ONT em cada lado, e o erro só aparecia quando um dos contratos ficava "Sem ONT".
 */

before(async () => {
  const { panelUrl } = await startTestServers();
  assert.ok(panelUrl);
  await asTenant(async () => {
    await SgpContact.upsertFromSgp({ contract: 'PD-1', client_name: 'Cliente PD', state: 'active', login: 'pd.um' });
    await SgpContact.upsertFromSgp({ contract: 'PD-2', client_name: 'Cliente PD', state: 'active', login: 'pd.dois' });
    for (const [device, contract, mode] of [['pd-ont-a', 'PD-1', 'auto'], ['pd-ont-b', 'PD-1', 'manual']]) {
      await SgpLink.upsert({
        device_id: device, contract, client_name: 'Cliente PD', state: 'active',
        link_mode: mode, login: 'pd.um', last_synced_at: new Date()
      });
    }
  });
});

after(async () => {
  await asTenant(async () => {
    await SgpLink.deleteByDeviceId('pd-ont-a');
    await SgpLink.deleteByDeviceId('pd-ont-b');
  });
  await stopTestServers();
});

describe('as ONTs de um contrato no perfil do contato', () => {
  it('lista todas, com o modo do vínculo, e mantém a primeira em deviceId', async () => {
    const profile = await asTenant(() => ContactProfileService.get('PD-1'));
    const contract = profile.contracts.find((entry) => entry.contract === 'PD-1');
    assert.deepEqual(contract.devices.map((entry) => entry.deviceId), ['pd-ont-a', 'pd-ont-b']);
    assert.deepEqual(contract.devices.map((entry) => entry.linkMode), ['auto', 'manual']);
    assert.equal(contract.deviceId, 'pd-ont-a');
    assert.equal(contract.hasDevice, true);
  });

  it('um contrato sem ONT tem a lista vazia', async () => {
    const profile = await asTenant(() => ContactProfileService.get('PD-2'));
    const contract = profile.contracts.find((entry) => entry.contract === 'PD-2');
    assert.deepEqual(contract.devices, []);
    assert.equal(contract.hasDevice, false);
  });
});
