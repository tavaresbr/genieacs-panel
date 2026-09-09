import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getDb, insertReturningId, runInTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: MapSettings } = await import('../src/models/MapSettings.js');

/**
 * The map centre, per provider.
 *
 * `map_settings` was the only unconverted table whose WHERE was not an identity
 * filter at all. It is a singleton keyed `id: 1`, so `where({ id: 1 })` meant
 * "the only row" — and the second provider to save its map centre wrote over
 * the first's, while `reset()` put the deployment's single row back to defaults
 * for everybody. There is nothing shared about a latitude: it is literally
 * where one ISP's city is.
 *
 * Migration 0025 makes the key `(tenant_id, id)`, so each provider keeps its
 * own row 1 and `tdb` supplies the provider half.
 */
let alfa;
let beta;

before(async () => {
  await startTestServers();
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  beta = await insertReturningId('tenants', {
    slug: 'beta', name: 'Provedor Beta', status: 'active'
  });
});

after(async () => {
  await stopTestServers();
});

const save = (tenant, patch) => runInTenant(tenant, () => MapSettings.upsert(patch));
const read = (tenant) => runInTenant(tenant, () => MapSettings.get());

const SANTAREM = { center_lat: '-2.4431', center_lng: '-54.7083', max_zoom_in: '19', max_zoom_out: '4', default_zoom: '14' };
const MANAUS = { center_lat: '-3.1190', center_lng: '-60.0217', max_zoom_in: '17', max_zoom_out: '6', default_zoom: '12' };

describe('two providers, two cities', () => {
  it('lets each keep its own centre', async () => {
    await save(alfa, SANTAREM);
    await save(beta, MANAUS);

    const deAlfa = await read(alfa);
    const deBeta = await read(beta);
    assert.equal(deAlfa.center_lat, SANTAREM.center_lat, 'Alfa is still where Alfa put it');
    assert.equal(deBeta.center_lat, MANAUS.center_lat);
    assert.notEqual(deAlfa.center_lat, deBeta.center_lat);
  });

  it('keeps a save by one from moving the other', async () => {
    await save(alfa, SANTAREM);
    await save(beta, MANAUS);
    // The bug, exactly: with one deployment-wide row, this second save WAS the
    // first provider's map from here on.
    await save(beta, { ...MANAUS, default_zoom: '15' });

    const deAlfa = await read(alfa);
    assert.equal(deAlfa.center_lat, SANTAREM.center_lat);
    assert.equal(deAlfa.default_zoom, SANTAREM.default_zoom, 'Alfa never asked for a new zoom');
  });

  it('resets one provider without resetting the other', async () => {
    await save(alfa, SANTAREM);
    await save(beta, MANAUS);

    await runInTenant(beta, () => MapSettings.reset());

    const deAlfa = await read(alfa);
    const deBeta = await read(beta);
    assert.equal(deAlfa.center_lat, SANTAREM.center_lat, 'a reset next door is not a reset here');
    assert.notEqual(deBeta.center_lat, MANAUS.center_lat, 'and Beta really did reset');
  });

  it('gives each provider its own row 1 rather than sharing one', async () => {
    await save(alfa, SANTAREM);
    await save(beta, MANAUS);

    // Read unfiltered on purpose: the claim is about what the TABLE holds. A
    // scoped read would show one row either way and prove nothing.
    const rows = await getDb()('map_settings').where({ id: 1 }).orderBy('tenant_id');
    assert.equal(rows.length, 2, 'the old primary key allowed exactly one');
    assert.deepEqual(rows.map((r) => Number(r.tenant_id)), [Number(alfa), Number(beta)]);
  });
});
