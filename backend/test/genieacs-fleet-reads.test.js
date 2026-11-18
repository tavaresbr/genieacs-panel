import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * As leituras da frota inteira e os laços de fundo por provedor.
 *
 * O que está em jogo aqui é desempenho sem mudar resposta: a mesma frota pedida
 * ao mesmo tempo vira UMA requisição, um provedor lento não segura os outros, e
 * a busca do sucessor de uma ONT parada deixa de ser quadrática na frota — com
 * exatamente a mesma resposta de antes.
 */
const { getDb, runInTenant, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { createFleetReads, forgetFleetReads } = await import('../src/services/genieacs/fleetReads.js');
const {
  FLEET_READ_LIMIT, fleetReadsForTenant, resetAcsConcurrency
} = await import('../src/services/genieacs/concurrency.js');
const { forEachTenant, forEveryTenant } = await import('../src/config/tenantJobs.js');
const { currentTenantId } = await import('../src/config/tenantContext.js');
const { default: SgpService } = await import('../src/services/sgpService.js');
const { default: DeviceHistoryService } = await import('../src/services/deviceHistoryService.js');
const { default: OutageWatcher } = await import('../src/services/outageWatcher.js');
const { default: MapStatusService } = await import('../src/services/mapStatusService.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { default: MappingNode } = await import('../src/models/MappingNode.js');

let alfa;
const extras = [];

before(async () => {
  await startTestServers();
  const db = getDb();
  alfa = (await db('tenants').orderBy('id', 'asc').first()).id;
  for (const slug of ['pool-b', 'pool-c', 'pool-d', 'pool-e', 'pool-f']) {
    await db('tenants').insert({ slug, name: slug, status: 'active' });
    extras.push((await db('tenants').where({ slug }).first()).id);
  }
});

after(async () => {
  await getDb()('tenants').whereIn('id', extras).del();
  await stopTestServers();
});

afterEach(() => {
  resetAcsConcurrency();
  forgetFleetReads();
});

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

describe('leituras de frota compartilhadas', () => {
  it('pedidos simultâneos da mesma chave viram uma leitura só', async () => {
    const reads = createFleetReads();
    let calls = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const load = async () => { calls += 1; await held; return ['frota']; };
    const pending = runInTenant(alfa, () => Promise.all([
      reads.read('k', load), reads.read('k', load), reads.read('k', load, { fresh: true })
    ]));
    await tick();
    release();
    const results = await pending;
    assert.equal(calls, 1);
    assert.ok(results.every((value) => value === results[0]));
    // Sem prazo, nada fica guardado depois que a leitura volta.
    await runInTenant(alfa, () => reads.read('k', load));
    assert.equal(calls, 2);
  });

  it('com prazo, serve o resultado guardado; `fresh` vai ao ACS; falha nunca é guardada', async () => {
    const reads = createFleetReads();
    let calls = 0;
    const load = async () => { calls += 1; return calls; };
    await runInTenant(alfa, async () => {
      assert.equal(await reads.read('k', load, { ttlMs: 60_000 }), 1);
      assert.equal(await reads.read('k', load, { ttlMs: 60_000 }), 1);
      assert.equal(await reads.read('k', load, { ttlMs: 60_000, fresh: true }), 2);
      assert.equal(await reads.read('k', load, { ttlMs: 60_000 }), 2, 'o fresco substitui o guardado');

      const falha = async () => { throw new Error('acs fora'); };
      await assert.rejects(reads.read('x', falha, { ttlMs: 60_000 }), /acs fora/);
      assert.equal(await reads.read('x', load, { ttlMs: 60_000 }), 3);
    });
  });

  it('cada provedor tem no máximo FLEET_READ_LIMIT leituras de frota no ar', async () => {
    const reads = createFleetReads();
    let peak = 0;
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const runs = runInTenant(alfa, () => Promise.all(Array.from({ length: FLEET_READ_LIMIT + 3 }, (unused, index) => (
      reads.read(`k${index}`, async () => {
        peak = Math.max(peak, fleetReadsForTenant());
        await held;
        return index;
      })
    ))));
    await tick();
    release();
    await runs;
    assert.equal(peak, FLEET_READ_LIMIT);
  });
});

describe('o laço por provedor com vagas', () => {
  it('visita todos, isola a falha, respeita o teto e mantém a ordem', async () => {
    let inFlight = 0;
    let peak = 0;
    const seen = [];
    const failures = [];
    const results = await forEachTenant(async (tenant) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // O escopo é do provedor visitado, mesmo com vários lado a lado.
      assert.equal(currentTenantId(), tenant.id);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      assert.equal(currentTenantId(), tenant.id);
      inFlight -= 1;
      seen.push(tenant.id);
      if (tenant.id === extras[1]) throw new Error('SGP fora do ar');
      return tenant.id;
    }, { concurrency: 3, onError: (error, tenant) => failures.push([tenant.id, error.message]) });

    const all = [alfa, ...extras];
    assert.deepEqual([...seen].sort((a, b) => a - b), all);
    assert.ok(peak > 1, 'roda provedores lado a lado');
    assert.ok(peak <= 3, `no máximo três ao mesmo tempo (foram ${peak})`);
    assert.deepEqual(failures, [[extras[1], 'SGP fora do ar']]);
    assert.deepEqual(results, all.filter((id) => id !== extras[1]), 'a ordem é a das linhas, sem quem falhou');
  });

  it('o agendador visita todo provedor lado a lado, e a falha de um não para os outros', async (t) => {
    const { default: SchedulerService } = await import('../src/services/schedulerService.js');
    let inFlight = 0;
    let peak = 0;
    const visited = [];
    t.mock.method(SchedulerService, 'runJobs', async ({ tenant }) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      inFlight -= 1;
      visited.push(currentTenantId());
      if (tenant.id === alfa) throw new Error('ACS do primeiro fora do ar');
      return {};
    });
    const warn = t.mock.method(console, 'warn', () => {});
    await SchedulerService.tick();
    assert.deepEqual([...visited].sort((a, b) => a - b), [alfa, ...extras]);
    assert.ok(peak > 1, 'os provedores não esperam um pelo outro');
    assert.ok(warn.mock.calls.some((call) => /Scheduler tick failed for provider/.test(String(call.arguments[0]))));
  });

  it('sem `concurrency`, continua em série', async () => {
    let inFlight = 0;
    let peak = 0;
    await forEveryTenant(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    assert.equal(peak, 1);
  });
});

describe('o sucessor de uma ONT parada', () => {
  // Um gerador determinístico: o mesmo caso toda vez que o teste roda.
  function rng(seed) {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }

  it('com o índice, a resposta é a mesma do laço sobre a frota inteira', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const random = rng(seed);
      const pick = (list) => list[Math.floor(random() * list.length)];
      const logins = ['ana@isp', 'ANA@isp ', 'bia@isp', 'caio@isp', '', null];
      const contracts = ['100', '200', '300', null];
      const base = Date.parse('2026-11-01T00:00:00Z');
      const devices = Array.from({ length: 60 }, (unused, index) => ({
        _id: random() < 0.03 ? '' : `ONT-${index}`,
        pppoe: pick(logins),
        // Instantes repetidos de propósito: é o empate que a ordem decide.
        _lastInform: random() < 0.1 ? null : new Date(base + Math.floor(random() * 8) * 3_600_000).toISOString()
      }));
      const links = new Map();
      for (const device of devices) {
        if (device._id && random() < 0.6) {
          links.set(device._id, { device_id: device._id, contract: pick(contracts), login: pick(logins) });
        }
      }
      const index = SgpService.successorIndex(devices, links);
      for (const device of devices) {
        const link = links.get(String(device._id));
        const antes = SgpService.findSuccessor(device, link, devices, links);
        const depois = SgpService.findSuccessor(device, link, devices, links, index);
        assert.deepEqual(depois, antes, `semente ${seed}, ${device._id}`);
      }
      // Um vínculo que sai do mapa depois do índice montado (`relinkStale`)
      // deixa de casar pelo contrato, nos dois caminhos.
      for (const id of [...links.keys()].slice(0, 10)) links.delete(id);
      for (const device of devices) {
        const link = links.get(String(device._id));
        assert.deepEqual(
          SgpService.findSuccessor(device, link, devices, links, index),
          SgpService.findSuccessor(device, link, devices, links),
          `semente ${seed}, ${device._id}, depois de tirar vínculos`
        );
      }
    }
  });
});

describe('as voltas de fundo não se sobrepõem', () => {
  it('o histórico: duas voltas ao mesmo tempo leem a frota uma vez', async (t) => {
    await runInTenant(alfa, () => DeviceHistoryService.saveConfig({ enabled: true, intervalSeconds: 300 }));
    let reads = 0;
    t.mock.method(DeviceService, 'getTelemetryFleet', async () => {
      reads += 1;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      return [];
    });
    await runInTenant(alfa, () => DeviceHistoryService.writeStamp('device_history_last_sample', 0)).catch(() => {});
    await Promise.all([DeviceHistoryService.tick(), DeviceHistoryService.tick()]);
    assert.equal(reads, 1);
    assert.equal(DeviceHistoryService.tickPromise, null, 'a guarda solta ao terminar');
    await runInTenant(alfa, () => DeviceHistoryService.saveConfig({ enabled: false }));
  });

  it('o vigia de rompimento: duas voltas ao mesmo tempo são uma', async (t) => {
    let passes = 0;
    t.mock.method(MappingNode, 'getAll', async () => [{ type: 'ont', pppoe: 'ana@isp' }]);
    t.mock.method(MapStatusService, 'status', async () => {
      passes += 1;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      return null;
    });
    await Promise.all([OutageWatcher.tick(), OutageWatcher.tick()]);
    assert.equal(passes, 1 + extras.length, 'uma passada por provedor, não duas');
    assert.equal(OutageWatcher.tickPromise, null);
  });

  it('o mapa: o cache vencido com várias telas abertas faz uma leitura só', async (t) => {
    MapStatusService.clearCache();
    let reads = 0;
    t.mock.method(DeviceService, 'getMapStatusFleet', async () => {
      reads += 1;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      return [{ deviceId: 'ONT-1', pppoe: 'ana@isp', online: true, rxPower: null }];
    });
    const fleets = await runInTenant(alfa, () => Promise.all([
      MapStatusService.fleet(), MapStatusService.fleet(), MapStatusService.fleet()
    ]));
    assert.equal(reads, 1);
    assert.equal(fleets[1], fleets[0]);
    await runInTenant(alfa, () => MapStatusService.fleet());
    assert.equal(reads, 1, 'e o resultado vale o prazo do cache');
    MapStatusService.clearCache();
  });
});
