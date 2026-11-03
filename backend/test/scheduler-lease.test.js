import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { acquireLease, releaseLease } = await import('../src/services/schedulerLease.js');

/**
 * A vez dos passos do agendador acima dos provedores (as verificações da
 * página de status, a passada dos lotes de afiliados) com várias instâncias:
 * uma linha em `app_state` da caixa da plataforma, tomada por inserção ou por
 * troca condicional, só depois de vencida.
 */
const aoSegundo = (ms) => new Date(Math.floor(ms / 1000) * 1000);

before(async () => {
  await startTestServers();
  const db = getDb();
  if (!(await db('tenants').where({ kind: 'platform' }).first())) {
    await db('tenants').insert({ slug: 'plataforma-vez', name: 'Plataforma', status: 'active', kind: 'platform' });
  }
});

after(async () => {
  await stopTestServers();
});

describe('a vez do agendador', () => {
  it('uma instância por intervalo; a outra entra quando vence', async () => {
    const agora = aoSegundo(Date.now());
    assert.equal(await acquireLease('teste-a', { ttlMs: 60_000, now: agora, holder: 'a' }), true);
    assert.equal(await acquireLease('teste-a', { ttlMs: 60_000, now: agora, holder: 'b' }), false);
    // Nem a própria repete dentro do intervalo: a vez é a passada.
    assert.equal(await acquireLease('teste-a', { ttlMs: 60_000, now: new Date(agora.getTime() + 30_000), holder: 'a' }), false);
    const depois = new Date(agora.getTime() + 61_000);
    assert.equal(await acquireLease('teste-a', { ttlMs: 60_000, now: depois, holder: 'b' }), true);
    assert.equal(await acquireLease('teste-a', { ttlMs: 60_000, now: depois, holder: 'a' }), false);
    // Outro nome é outra vez.
    assert.equal(await acquireLease('teste-b', { ttlMs: 60_000, now: agora, holder: 'a' }), true);
  });

  it('na disputa simultânea, só uma ganha — na linha nova e na vencida', async () => {
    const agora = aoSegundo(Date.now());
    const disputa = (now) => Promise.all(['x', 'y', 'z'].map((holder) => acquireLease('teste-corrida', { ttlMs: 10_000, now, holder })));
    assert.equal((await disputa(agora)).filter(Boolean).length, 1);
    assert.equal((await disputa(new Date(agora.getTime() + 11_000))).filter(Boolean).length, 1);
  });

  it('quem tem a vez pode devolvê-la; quem não tem, não', async () => {
    const agora = aoSegundo(Date.now());
    assert.equal(await acquireLease('teste-devolve', { ttlMs: 60_000, now: agora, holder: 'a' }), true);
    assert.equal(await releaseLease('teste-devolve', { holder: 'b' }), false);
    assert.equal(await releaseLease('teste-devolve', { holder: 'a' }), true);
    assert.equal(await acquireLease('teste-devolve', { ttlMs: 60_000, now: agora, holder: 'b' }), true);
  });
});
