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
const {
  NBI_URL_BUDGET, createFleetReads, createFleetSnapshots, forgetFleetReads
} = await import('../src/services/genieacs/fleetReads.js');
const { DEVICE_SCOPE_KEY, forgetSharedAcs, withoutDeviceScope } = await import('../src/services/genieacs/direct.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: WaAlertService } = await import('../src/services/waAlertService.js');
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

describe('a foto da frota: uma leitura por provedor com a projeção unida', () => {
  let genie;
  let outro;

  const leiturasDaFrota = (stub) => stub.state.requests.filter(
    (req) => req.method === 'GET' && (req.path === '/devices' || req.path === '/devices/')
  );
  const projecaoDe = (req) => new URLSearchParams(req.search).get('projection').split(',');

  let egressoReal;

  before(async () => {
    // Com seis provedores na tabela a instalação é "compartilhada" e o egresso
    // recusa a porta aleatória do ACS falso; o assunto aqui é a foto, não o
    // egresso (a mesma troca de `shared-acs-scope.test.js`).
    const { default: GenieAcsEgress } = await import('../src/services/genieacsEgress.js');
    egressoReal = GenieAcsEgress.fetch;
    GenieAcsEgress.fetch = (url, options) => fetch(url, options);
    const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
    genie = await startGenieAcsStub({
      devices: [
        buildDevice({ id: 'ONT-A1', pppoeUsername: 'ana@alfa', tags: ['alfa'] }),
        buildDevice({ id: 'ONT-B1', pppoeUsername: 'bia@beta', tags: ['beta'] })
      ]
    });
    outro = await startGenieAcsStub({ devices: [buildDevice({ id: 'ONT-X1', pppoeUsername: 'xis@outro' })] });
    await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', genie.url));
    await runInTenant(extras[0], () => Setting.upsert('genieAcsUrl', outro.url));
  });

  after(async () => {
    const { default: GenieAcsEgress } = await import('../src/services/genieacsEgress.js');
    GenieAcsEgress.fetch = egressoReal;
    await runInTenant(alfa, () => Setting.upsert(DEVICE_SCOPE_KEY, ''));
    await getDb()('settings').whereIn('tenant_id', extras).del();
    await genie.close();
    await outro.close();
  });

  afterEach(() => {
    genie.state.requests.length = 0;
    outro.state.requests.length = 0;
    MapStatusService.clearCache();
    forgetSharedAcs();
  });

  it('painel + alertas + mapa (e telemetria e identidade) dentro do prazo: 1 leitura do ACS', async (t) => {
    // A varredura de alertas até a leitura da frota: o que vem antes dela
    // (canais, contas do WhatsApp) e o que vem depois (avisar) não é o assunto.
    t.mock.method(WaAlertService, 'getSettings', async () => ({ enabled: true, rules: {} }));
    t.mock.method(WaAlertService, 'readyChannels', async () => ({ whatsapp: true }));
    t.mock.method(WaAlertService, 'evaluateAccounts', async () => ({ firing: [], unknown: [] }));
    t.mock.method(WaAlertService, 'evaluateWaiting', async () => ({ firing: [], unknown: [] }));
    t.mock.method(WaAlertService, 'avisarFilaTravada', async () => {});
    t.mock.method(WaAlertService, 'reconcile', async () => {});
    let avaliados = null;
    t.mock.method(WaAlertService, 'evaluate', async (devices) => { avaliados = devices; return { firing: [], unknown: [] }; });

    await runInTenant(alfa, async () => {
      const painel = await DeviceService.getDashboardDevices();
      const resumo = await WaAlertService.runScan();
      const mapa = await MapStatusService.fleet();
      const telemetria = await DeviceService.getTelemetryFleet();
      const identidade = await DeviceService.getCustomerIdentityDevices();

      assert.equal(leiturasDaFrota(genie).length, 1, 'uma leitura da frota para os cinco leitores');
      assert.equal(resumo.error ?? null, null);
      assert.equal(avaliados?.length, 2, 'a varredura recebeu a frota');
      assert.equal(painel.length, 2);
      // Cada leitor continua lendo o que é seu na linha compartilhada.
      assert.deepEqual(mapa.map((d) => d.pppoe).sort(), ['ana@alfa', 'bia@beta']);
      assert.equal(telemetria.find((d) => d.deviceId === 'ONT-A1').uptime, 86_400);
      assert.equal(identidade.find((d) => d._id === 'ONT-A1').softwareId, 'V1.0.0');

      // A primeira leitura já pediu o que os outros quatro precisavam.
      const campos = projecaoDe(leiturasDaFrota(genie)[0]);
      for (const campo of [
        '_registered', 'InternetGatewayDevice.DeviceInfo.UpTime',
        'InternetGatewayDevice.DeviceInfo.SoftwareVersion', '_lastInform'
      ]) {
        assert.ok(campos.includes(campo), `a projeção unida traz ${campo}`);
      }
    });
  });

  it('o "atualizar" do painel (fresh) vai ao ACS e renova a foto para os outros', async () => {
    await runInTenant(alfa, async () => {
      await DeviceService.getDashboardDevices();
      await DeviceService.getDashboardDevices({ fresh: true });
      assert.equal(leiturasDaFrota(genie).length, 2);
      await DeviceService.getMapStatusFleet();
      await DeviceService.getTelemetryFleet();
      assert.equal(leiturasDaFrota(genie).length, 2, 'a foto nova serve os seguintes');
    });
  });

  it('o que o operador pede (sincronizar IDs, visão geral do SGP) vai ao ACS, mesmo com a foto nova', async (t) => {
    const { default: CustomerIdSyncJob } = await import('../src/services/customerIdSyncJob.js');
    t.mock.method(CustomerIdSyncJob, 'remember', async () => {});
    await runInTenant(alfa, async () => {
      await DeviceService.getDashboardDevices();
      assert.equal(leiturasDaFrota(genie).length, 1);
      // O laço de fundo aceita a foto…
      await DeviceService.getCustomerIdentityDevices();
      assert.equal(leiturasDaFrota(genie).length, 1);
      // …o botão "sincronizar IDs de cliente" não.
      const resumo = await CustomerIdSyncJob.run(`fresh-${alfa}`);
      assert.equal(resumo.total, 2);
      assert.equal(leiturasDaFrota(genie).length, 2);
    });

    // As telas e botões do SGP e da manutenção pedem `fresh`.
    const pedidos = [];
    t.mock.method(DeviceService, 'getCustomerIdentityDevices', async (options) => {
      pedidos.push(options?.fresh === true);
      return [];
    });
    t.mock.method(SgpService, 'getConfig', async () => ({ linkMode: 'pppoe' }));
    t.mock.method(SgpService, 'requireReady', (config) => config);
    await runInTenant(alfa, () => SgpService.getFleetOverview());
    assert.deepEqual(pedidos, [true], 'a visão geral');
    pedidos.length = 0;
    t.mock.method(SgpService, 'relinkStale', async (options) => {
      pedidos.push(options?.fresh === true);
      return { relinked: 0, stranded: new Set() };
    });
    await runInTenant(alfa, () => SgpService.syncFleet());
    assert.deepEqual(pedidos, [true, false], 'sincronizar o SGP: uma leitura na hora, e a segunda usa ela');
  });

  it('leitores ao mesmo tempo esperam a mesma leitura em voo', async () => {
    await runInTenant(alfa, () => Promise.all([
      DeviceService.getDashboardDevices(),
      DeviceService.getMapStatusFleet(),
      DeviceService.getTelemetryFleet(),
      DeviceService.getCustomerIdentityDevices()
    ]));
    assert.equal(leiturasDaFrota(genie).length, 1);
  });

  it('nunca de um provedor para outro, nem para outro endereço do mesmo provedor', async () => {
    await runInTenant(alfa, () => DeviceService.getDashboardDevices());
    const doOutro = await runInTenant(extras[0], () => DeviceService.getMapStatusFleet());
    assert.deepEqual(doOutro.map((d) => d.deviceId), ['ONT-X1']);
    assert.equal(leiturasDaFrota(outro).length, 1);

    // O mesmo provedor passa a apontar para outro ACS (sem o console
    // esquecer nada): a foto do endereço antigo não serve.
    await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', outro.url));
    try {
      const depois = await runInTenant(alfa, () => DeviceService.getMapStatusFleet());
      assert.deepEqual(depois.map((d) => d.deviceId), ['ONT-X1']);
      assert.equal(leiturasDaFrota(outro).length, 2);
    } finally {
      await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', genie.url));
    }
  });

  it('a leitura sem escopo (marcação automática) e a com escopo nunca dividem foto', async () => {
    await runInTenant(alfa, () => Setting.upsert(DEVICE_SCOPE_KEY, 'alfa'));
    forgetSharedAcs();
    try {
      const comEscopo = await runInTenant(alfa, () => DeviceService.getTelemetryFleet());
      assert.deepEqual(comEscopo.map((d) => d.deviceId), ['ONT-A1']);
      const semEscopo = await runInTenant(alfa, () => withoutDeviceScope(() => DeviceService.getTelemetryFleet()));
      assert.deepEqual(semEscopo.map((d) => d.deviceId).sort(), ['ONT-A1', 'ONT-B1']);
      const deNovo = await runInTenant(alfa, () => DeviceService.getMapStatusFleet());
      assert.deepEqual(deNovo.map((d) => d.deviceId), ['ONT-A1'], 'a com escopo continua só com a dela');
      const leituras = leiturasDaFrota(genie);
      assert.equal(leituras.length, 2);
      assert.ok(new URLSearchParams(leituras[0].search).get('query').includes('alfa'));
      assert.equal(new URLSearchParams(leituras[1].search).get('query'), null);
    } finally {
      await runInTenant(alfa, () => Setting.upsert(DEVICE_SCOPE_KEY, ''));
    }
  });

  it('projeção unida grande demais para a URL: cada um lê o seu, sem foto unida', async (t) => {
    const enorme = Array.from({ length: 200 }, (unused, i) => `InternetGatewayDevice.X_VENDOR.Muito.Comprido.Campo.${i}.Valor`);
    t.mock.method(DeviceService, 'fleetSnapshotUnion', async () => enorme);
    await runInTenant(alfa, async () => {
      await DeviceService.getDashboardDevices();
      await DeviceService.getMapStatusFleet();
    });
    const leituras = leiturasDaFrota(genie);
    assert.equal(leituras.length, 2, 'duas leituras separadas');
    for (const req of leituras) {
      assert.ok(req.search.length < NBI_URL_BUDGET, 'cada uma cabe na URL');
      assert.ok(!projecaoDe(req).includes(enorme[0]));
    }
    assert.equal(DeviceService.fleetSnapshots.size, 0);
  });
});

describe('a família de fotos', () => {
  it('em voo: quem pede um subconjunto espera; quem pede campo a mais lê de novo', async () => {
    const fotos = createFleetSnapshots();
    const projecoes = [];
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const load = async (projection) => { projecoes.push(projection); await held; return [{ _id: 'x' }]; };
    const pending = runInTenant(alfa, () => Promise.all([
      fotos.read('k', ['a', 'b'], { load, union: async () => ['c'] }),
      fotos.read('k', ['c'], { load }),
      fotos.read('k', ['a'], { load, fresh: true }),
      fotos.read('k', ['z'], { load })
    ]));
    await tick();
    release();
    await pending;
    assert.equal(projecoes.length, 2);
    assert.deepEqual(projecoes[0], ['a', 'b', 'c']);
    assert.deepEqual(projecoes[1], ['z']);
  });

  it('a foto sai da memória quando vence; falha não vira foto', async () => {
    const fotos = createFleetSnapshots();
    let calls = 0;
    const load = async () => { calls += 1; return [calls]; };
    await runInTenant(alfa, async () => {
      await fotos.read('k', ['a'], { load, ttlMs: 20 });
      assert.equal(fotos.size, 1);
      assert.deepEqual(await fotos.read('k', ['a'], { load, ttlMs: 20 }), [1]);
      await new Promise((resolve) => { setTimeout(resolve, 40); });
      assert.equal(fotos.size, 0, 'vencida, sai sem esperar a próxima leitura');
      await assert.rejects(fotos.read('f', ['a'], { load: async () => { throw new Error('acs fora'); }, ttlMs: 1000 }));
      assert.equal(fotos.size, 0);
    });
  });

  it('esquecer no meio da leitura: o que ela trouxer não vira foto', async () => {
    const fotos = createFleetSnapshots();
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const pending = runInTenant(alfa, () => fotos.read('k', ['a'], {
      load: async () => { await held; return []; }, ttlMs: 60_000
    }));
    await tick();
    forgetFleetReads();
    release();
    await pending;
    assert.equal(fotos.size, 0);
  });
});
