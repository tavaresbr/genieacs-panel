import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Vários provedores no MESMO GenieACS.
 *
 * O endereço do ACS não separa nada quando ele é compartilhado: sem a tag de
 * equipamentos, cada provedor via — e podia reiniciar, apagar, resetar — a
 * frota de todos. Com a tag, o provedor só enxerga e só age no que é dele, e
 * um equipamento de outro responde "não encontrado", nunca "é de outro".
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, defaultTenantId, getDb, runInTenant, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { buildDevice, startGenieAcsStub } = await import('./helpers/genieacs-stub.js');
const { default: Setting } = await import('../src/models/Setting.js');
const { default: DeviceService } = await import('../src/services/deviceService.js');
const { default: GenieAcsEgress } = await import('../src/services/genieacsEgress.js');
const { forgetSharedAcs } = await import('../src/services/genieacs/direct.js');
const { default: SchedulerService } = await import('../src/services/schedulerService.js');
const { default: AppState } = await import('../src/models/AppState.js');
const { default: DeviceScopeTagger } = await import('../src/services/deviceScopeTagger.js');

// A guarda de egresso da SaaS recusa loopback, com razão — e o ACS de mentira
// deste teste mora no loopback. A guarda tem os testes dela; aqui o que está em
// jogo é o escopo do provedor, então o transporte vai direto.
const egressoReal = GenieAcsEgress.fetch;
GenieAcsEgress.fetch = (url, options) => fetch(url, options);

const OWNER = { username: 'dono', password: 'dono-senha-123', email: 'dono@exemplo.test' };

let panelUrl;
let genie;
let token;
let alfa;
let beta;

const api = (path, options = {}) => call(`${panelUrl}/api${path}`, {
  ...options,
  headers: { ...authHeaders(token), ...(options.headers || {}) }
});

/** As leituras de lista da marcação (com `$nin`), sem as contagens. */
const listasDaMarcacao = (requests) => requests.filter((r) => r.method === 'GET' && /^\/devices\/?$/.test(r.path)
  && (new URLSearchParams(r.search).get('query') || '').includes('$nin'));

const frota = () => [
  buildDevice({ id: 'ONT-ALFA-1', tags: ['alfa'], pppoeUsername: 'alfa1@isp' }),
  buildDevice({ id: 'ONT-ALFA-2', tags: ['alfa', 'contrato_10'], pppoeUsername: 'alfa2@isp' }),
  buildDevice({ id: 'ONT-BETA-1', tags: ['beta'], pppoeUsername: 'beta1@isp' }),
  buildDevice({ id: 'ONT-SEMDONO', tags: [], pppoeUsername: 'TA100-novo@isp' })
];

const definirTag = (tenantId, tag) => runInTenant(tenantId, () => Setting.upsert('deviceScopeTag', tag));

before(async () => {
  ({ panelUrl } = await startTestServers());
  genie = await startGenieAcsStub({ devices: frota() });
  alfa = await defaultTenantId();

  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: OWNER });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  const userId = setup.body.data.user.id;
  if (!(await getDb()('platform_admins').where({ user_id: userId }).first())) {
    await getDb()('platform_admins').insert({ user_id: userId });
  }
  const criado = await api('/platform/tenants', { method: 'POST', body: { slug: 'beta', name: 'Beta' } });
  assert.equal(criado.status, 201);
  beta = criado.body.data.tenant.id;

  // Os dois no MESMO ACS — o caso que motivou tudo isto.
  await runInTenant(alfa, () => Setting.upsert('genieAcsUrl', genie.url));
  await runInTenant(beta, () => Setting.upsert('genieAcsUrl', genie.url));
});

after(async () => {
  GenieAcsEgress.fetch = egressoReal;
  await genie.close();
  await stopTestServers();
});

beforeEach(async () => {
  genie.state.devices = frota();
  genie.state.applyTags = false;
  genie.state.unsupported = [];
  genie.state.unsupportedReply = 'empty';
  DeviceScopeTagger.fullReadAcs.clear();
  genie.state.tasks.length = 0;
  genie.state.tags.length = 0;
  genie.state.deleted.length = 0;
  genie.state.faults = [];
  genie.state.deletedFaults = [];
  await definirTag(alfa, 'alfa');
  await definirTag(beta, 'beta');
  for (const id of [alfa, beta]) {
    await runInTenant(id, async () => {
      await Setting.upsert('deviceScopeAutoPrefixes', '');
      await AppState.upsert('scheduler_state', '{}');
    });
  }
  await runInTenant(beta, () => Setting.upsert('genieAcsUrl', genie.url));
  forgetSharedAcs();
  DeviceService.forgetDashboards();
});

describe('um GenieACS compartilhado, com a tag do provedor', () => {
  it('a lista e a contagem mostram só os equipamentos do provedor', async () => {
    const { status, body } = await api('/devices?pageSize=50');
    assert.equal(status, 200, JSON.stringify(body));
    assert.deepEqual(body.data.devices.map((d) => d._id).sort(), ['ONT-ALFA-1', 'ONT-ALFA-2']);
    assert.equal(body.data.total, 2);
  });

  it('o Dashboard conta só a frota do provedor', async () => {
    const { status, body } = await api('/devices/dashboard?refresh=1');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.stats.total, 2);
  });

  it('sem tag num ACS que outro provedor usa, não vê nada — nem na lista, nem no Dashboard', async () => {
    await definirTag(alfa, '');
    const lista = await api('/devices?pageSize=50');
    assert.equal(lista.body.data.total, 0);
    const painel = await api('/devices/dashboard?refresh=1');
    assert.equal(painel.body.data.stats.total, 0);
  });

  it('sem tag com o ACS só dele, tudo como antes', async () => {
    await definirTag(alfa, '');
    await runInTenant(beta, () => Setting.upsert('genieAcsUrl', 'http://outro-acs.exemplo:7557'));
    forgetSharedAcs();
    const { body } = await api('/devices?pageSize=50');
    assert.equal(body.data.total, 4);
  });

  it('o Dashboard guardado de antes da separação não é servido depois dela', async () => {
    await definirTag(alfa, '');
    await runInTenant(beta, () => Setting.upsert('genieAcsUrl', 'http://outro-acs.exemplo:7557'));
    forgetSharedAcs();
    const antes = await api('/devices/dashboard?refresh=1');
    assert.equal(antes.body.data.stats.total, 4);

    // Outro provedor passa a usar o mesmo ACS: sem refresh forçado, o painel
    // montado com a frota inteira tem que ser descartado.
    await runInTenant(beta, () => Setting.upsert('genieAcsUrl', genie.url));
    forgetSharedAcs();
    const depois = await api('/devices/dashboard');
    assert.equal(depois.body.data.stats.total, 0);

    await definirTag(alfa, 'alfa');
    const comTag = await api('/devices/dashboard');
    assert.equal(comTag.body.data.stats.total, 2);
  });

  it('a posse conferida vale um minuto; a recusa nunca é guardada', async () => {
    const conferencias = () => genie.state.requests.filter((r) => r.method === 'GET'
      && /^\/devices\/?$/.test(r.path)
      && /ONT-ALFA-1/.test(decodeURIComponent(r.search)) && /_tags/.test(decodeURIComponent(r.search))
      && new URLSearchParams(r.search).get('projection') === '_id').length;
    const antes = conferencias();
    for (let vez = 0; vez < 3; vez += 1) {
      const r = await api('/devices/reboot', { method: 'POST', body: { deviceId: 'ONT-ALFA-1' } });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    assert.equal(conferencias() - antes, 1, 'três ações, uma pergunta de posse');
    for (let vez = 0; vez < 2; vez += 1) {
      const r = await api('/devices/reboot', { method: 'POST', body: { deviceId: 'ONT-BETA-1' } });
      assert.equal(r.status, 404);
    }
    // A plataforma troca a tag: o que foi conferido com a tag velha não vale.
    forgetSharedAcs();
    await api('/devices/reboot', { method: 'POST', body: { deviceId: 'ONT-ALFA-1' } });
    assert.equal(conferencias() - antes, 2);
  });

  it('o detalhe de um equipamento de outro provedor é "não encontrado"', async () => {
    const { status } = await api(`/devices/${encodeURIComponent('ONT-BETA-1')}`);
    assert.equal(status, 404);
    const meu = await api(`/devices/${encodeURIComponent('ONT-ALFA-1')}`);
    assert.equal(meu.status, 200);
  });

  it('reiniciar, apagar e diagnosticar um equipamento de outro provedor nunca chega ao ACS', async () => {
    const reboot = await api('/devices/reboot', { method: 'POST', body: { deviceId: 'ONT-BETA-1' } });
    assert.equal(reboot.status, 404, JSON.stringify(reboot.body));
    const apagar = await api(`/devices/${encodeURIComponent('ONT-BETA-1')}`, {
      method: 'DELETE',
      body: { confirmSerial: 'ZTEG12345678', password: OWNER.password, passwordConfirm: OWNER.password }
    });
    assert.equal(apagar.status, 404, JSON.stringify(apagar.body));
    const reset = await api('/devices/factory-reset', {
      method: 'POST',
      body: { deviceId: 'ONT-BETA-1', confirmSerial: 'ZTEG12345678', password: OWNER.password, passwordConfirm: OWNER.password }
    });
    assert.equal(reset.status, 404, JSON.stringify(reset.body));
    assert.equal(genie.state.tasks.length, 0, 'nenhuma tarefa pode ter saído');
    assert.deepEqual(genie.state.deleted, []);

    const meu = await api('/devices/reboot', { method: 'POST', body: { deviceId: 'ONT-ALFA-1' } });
    assert.equal(meu.status, 200, JSON.stringify(meu.body));
    assert.deepEqual(genie.state.tasks.map((t) => t.deviceId), ['ONT-ALFA-1']);
  });

  it('as falhas do ACS vêm só dos equipamentos do provedor, e só essas se apagam', async () => {
    genie.state.faults = [
      { _id: 'ONT-ALFA-1:default', device: 'ONT-ALFA-1', channel: 'default', code: 'cwmp.9002', message: 'alfa', timestamp: '2026-09-20T10:00:00.000Z' },
      { _id: 'ONT-BETA-1:default', device: 'ONT-BETA-1', channel: 'default', code: 'cwmp.9002', message: 'beta', timestamp: '2026-09-20T11:00:00.000Z' }
    ];
    const lista = await api('/devices/faults');
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    const texto = JSON.stringify(lista.body.data);
    assert.ok(texto.includes('ONT-ALFA-1'));
    assert.ok(!texto.includes('ONT-BETA-1'), 'a falha do outro provedor não aparece');

    const alheia = await api(`/devices/faults/${encodeURIComponent('ONT-BETA-1:default')}`, { method: 'DELETE' });
    assert.equal(alheia.status, 404, JSON.stringify(alheia.body));
    assert.deepEqual(genie.state.deletedFaults, []);
  });

  it('ninguém põe nem tira a tag de um provedor pela API do painel', async () => {
    await assert.rejects(
      runInTenant(alfa, () => DeviceService.mutateDeviceTag('ONT-ALFA-1', 'alfa', 'DELETE')),
      (error) => error.translationKey === 'device.scopeTagProtected'
    );
    await assert.rejects(
      runInTenant(alfa, () => DeviceService.mutateDeviceTag('ONT-ALFA-1', 'beta', 'POST')),
      (error) => error.translationKey === 'device.scopeTagProtected'
    );
    assert.deepEqual(genie.state.tags, []);
  });

  it('o provedor não grava a própria tag pela tela dele', async () => {
    const { status } = await api('/settings/deviceScopeTag', { method: 'PUT', body: { value: 'outra' } });
    assert.notEqual(status, 200);
    assert.equal(await runInTenant(alfa, () => Setting.getByKey('deviceScopeTag')), 'alfa');
  });
});

describe('o console da plataforma', () => {
  it('grava a tag, recusa uma inválida e uma que já é de outro provedor', async () => {
    const invalida = await api(`/platform/tenants/${beta}/genieacs`, { method: 'PUT', body: { deviceTag: 'com espaço' } });
    assert.equal(invalida.status, 400);
    const gerenciada = await api(`/platform/tenants/${beta}/genieacs`, { method: 'PUT', body: { deviceTag: 'contrato_x' } });
    assert.equal(gerenciada.status, 400);
    const repetida = await api(`/platform/tenants/${beta}/genieacs`, { method: 'PUT', body: { deviceTag: 'alfa' } });
    assert.equal(repetida.status, 409);
    const ok = await api(`/platform/tenants/${beta}/genieacs`, { method: 'PUT', body: { deviceTag: 'beta_novo' } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.deviceTag, 'beta_novo');
  });

  it('avisa quando dois provedores dividem o ACS e algum está sem tag', async () => {
    await definirTag(beta, '');
    const { body } = await api(`/platform/tenants/${alfa}/genieacs`);
    assert.equal(body.data.sharedAcs.missingTag, true);
    assert.ok(body.data.sharedAcs.providers.some((p) => p.id === beta));
  });

  it('marca em lote os equipamentos sem dono pelo prefixo do PPPoE, contando antes', async () => {
    const previa = await api(`/platform/tenants/${alfa}/genieacs/tag-devices`, {
      method: 'POST', body: { pppoePrefix: 'TA100' }
    });
    assert.equal(previa.status, 200, JSON.stringify(previa.body));
    assert.equal(previa.body.data.toTag, 1);
    assert.equal(previa.body.data.tagged, 0);
    assert.deepEqual(genie.state.tags, [], 'a prévia não marca nada');

    const feito = await api(`/platform/tenants/${alfa}/genieacs/tag-devices`, {
      method: 'POST', body: { pppoePrefix: 'TA100', apply: true }
    });
    assert.equal(feito.status, 200, JSON.stringify(feito.body));
    assert.equal(feito.body.data.tagged, 1);
    assert.deepEqual(genie.state.tags, [{ deviceId: 'ONT-SEMDONO', tag: 'alfa', method: 'POST' }]);
  });

  it('não toma equipamento que já é de outro provedor', async () => {
    const { body } = await api(`/platform/tenants/${alfa}/genieacs/tag-devices`, {
      method: 'POST', body: { pppoePrefix: 'beta', apply: true }
    });
    assert.equal(body.data.tagged, 0);
    assert.equal(body.data.conflictCount, 1);
    assert.deepEqual(genie.state.tags, []);
  });

  it('as contas do console: o ACS filtra quem já tem a tag, e a soma continua certa', async () => {
    genie.state.devices.push(
      buildDevice({ id: 'ONT-ALFA-3', tags: [], pppoeUsername: 'ALFA3@isp' }),
      buildDevice({ id: 'ONT-ALFA-9', tags: ['beta'], pppoeUsername: 'alfa9@isp' }),
      buildDevice({ id: 'ONT-ALFA-X', tags: ['alfa', 'beta'], pppoeUsername: 'alfa10@isp' })
    );
    const antes = genie.state.requests.length;
    const { status, body } = await api(`/platform/tenants/${alfa}/genieacs/tag-devices`, {
      method: 'POST', body: { pppoePrefix: 'alfa' }
    });
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.data.alreadyTagged, 3, 'ALFA-1, ALFA-2 e a ALFA-X, que também tem a da beta');
    assert.equal(body.data.toTag, 1);
    assert.equal(body.data.conflictCount, 1);
    assert.deepEqual(body.data.conflicts.map((c) => c.id), ['ONT-ALFA-9']);
    assert.equal(body.data.matched, 5);
    assert.equal(body.data.tagged, 0);

    const pedidos = genie.state.requests.slice(antes).filter((r) => r.method === 'GET' && /^\/devices\/?$/.test(r.path));
    const lista = listasDaMarcacao(pedidos);
    assert.equal(lista.length, 1);
    const busca = JSON.parse(new URLSearchParams(lista[0].search).get('query'));
    assert.deepEqual(busca.$and[0], { _tags: { $nin: ['alfa'] } });
    assert.ok(busca.$and[1].$or.some((parte) => Object.keys(parte)[0].endsWith('._value')));
    // A contagem pede só os `_id` dos que casam e já têm a tag.
    const contagens = pedidos.filter((r) => new URLSearchParams(r.search).get('projection') === '_id');
    assert.ok(contagens.length >= 1);
    assert.deepEqual(JSON.parse(new URLSearchParams(contagens[0].search).get('query')).$and[0], { _tags: 'alfa' });
  });

  const frotaDoConsole = () => {
    genie.state.devices.push(
      buildDevice({ id: 'ONT-ALFA-3', tags: [], pppoeUsername: 'ALFA3@isp' }),
      buildDevice({ id: 'ONT-ALFA-9', tags: ['beta'], pppoeUsername: 'alfa9@isp' })
    );
  };

  it('ACS que responde nada ao $nin: cai na leitura inteira, marca certo e lembra do ACS', async (t) => {
    genie.state.applyTags = true;
    genie.state.unsupported = ['$nin'];
    genie.state.unsupportedReply = 'empty';
    frotaDoConsole();
    const avisos = t.mock.method(console, 'warn', () => {});

    const r = await runInTenant(alfa, () => DeviceScopeTagger.run({ prefixes: ['alfa'], apply: true }));
    assert.equal(r.tagged, 1);
    assert.deepEqual(genie.state.tags, [{ deviceId: 'ONT-ALFA-3', tag: 'alfa', method: 'POST' }]);
    assert.equal(r.alreadyTagged, 2);
    assert.equal(r.toTag, 1);
    assert.equal(r.conflictCount, 1);
    assert.deepEqual(r.conflicts.map((c) => c.id), ['ONT-ALFA-9']);
    assert.equal(r.matched, 4);
    const linhas = avisos.mock.calls.map((call) => call.arguments.join(' ')).filter((linha) => /auto-tag/.test(linha));
    assert.deepEqual(linhas, ['Device scope auto-tag: the ACS did not honour the narrowed query; using the full fleet read']);

    // A próxima passada no mesmo ACS vai direto pela leitura inteira.
    const antes = genie.state.requests.length;
    const depois = await runInTenant(alfa, () => DeviceScopeTagger.run({ prefixes: ['alfa'] }));
    assert.equal(listasDaMarcacao(genie.state.requests.slice(antes)).length, 0, 'nem tenta o $nin de novo');
    assert.equal(depois.alreadyTagged, 3);
    assert.equal(depois.toTag, 0);
    assert.equal(depois.matched, 4);
  });

  it('ACS que recusa $nin/$or com 400: cai na leitura inteira com as mesmas contas', async (t) => {
    genie.state.unsupported = ['$nin', '$or'];
    genie.state.unsupportedReply = 400;
    frotaDoConsole();
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    const r = await runInTenant(alfa, () => DeviceScopeTagger.run({ prefixes: ['alfa'] }));
    assert.equal(r.alreadyTagged, 2);
    assert.equal(r.toTag, 1);
    assert.equal(r.conflictCount, 1);
    assert.equal(r.matched, 4);
    assert.equal(r.tagged, 0);
    assert.equal(DeviceScopeTagger.fullReadAcs.size, 1);
  });

  it('ACS que responde nada ao $or (calado, sem 4xx): a conferência zerada também cai na leitura inteira', async (t) => {
    genie.state.applyTags = true;
    genie.state.unsupported = ['$or'];
    genie.state.unsupportedReply = 'empty';
    frotaDoConsole();
    t.mock.method(console, 'warn', () => {});
    const r = await runInTenant(alfa, () => DeviceScopeTagger.run({ prefixes: ['alfa'], apply: true }));
    assert.equal(r.tagged, 1);
    assert.deepEqual(genie.state.tags, [{ deviceId: 'ONT-ALFA-3', tag: 'alfa', method: 'POST' }]);
    assert.equal(r.alreadyTagged, 2);
    assert.equal(r.conflictCount, 1);
    assert.equal(r.matched, 4);
    assert.equal(DeviceScopeTagger.fullReadAcs.size, 1);
  });

  it('busca estreita vazia de verdade (todos já marcados) não cai na leitura inteira', async () => {
    const r = await runInTenant(alfa, () => DeviceScopeTagger.run({ prefixes: ['alfa'] }));
    assert.equal(r.alreadyTagged, 2);
    assert.equal(r.toTag, 0);
    assert.equal(r.matched, 2);
    assert.equal(DeviceScopeTagger.fullReadAcs.size, 0);
  });

  it('por serial; lista grande demais para a URL vai só com o $nin, com as mesmas contas', async () => {
    const comSerial = (id, serial, tags) => {
      const device = buildDevice({ id, tags, pppoeUsername: `${id}@isp` });
      device._deviceId._SerialNumber = serial;
      return device;
    };
    genie.state.devices = [
      comSerial('S-1', 'zteg00000001', []),
      comSerial('S-2', 'ZTEG00000002', ['alfa']),
      comSerial('S-3', 'ZTEG00000003', ['beta']),
      comSerial('S-4', 'ZTEG00000004', [])
    ];
    const alvo = ['ZTEG00000001', 'ZTEG00000002', 'ZTEG00000003'];
    const pequena = await runInTenant(alfa, () => DeviceScopeTagger.run({ serials: new Set(alvo) }));
    const muitos = [...alvo, ...Array.from({ length: 1500 }, (unused, i) => `FHTT${String(i).padStart(8, '0')}`)];
    const antes = genie.state.requests.length;
    const grande = await runInTenant(alfa, () => DeviceScopeTagger.run({ serials: new Set(muitos) }));
    for (const r of [pequena, grande]) {
      assert.equal(r.toTag, 1, 'S-1, com o serial em minúsculas no ACS');
      assert.equal(r.alreadyTagged, 1);
      assert.equal(r.conflictCount, 1);
      assert.equal(r.matched, 3);
    }
    const pedidos = genie.state.requests.slice(antes).filter((r) => r.method === 'GET' && /^\/devices\/?$/.test(r.path));
    assert.ok(pedidos.every((r) => r.search.length < 8192), 'nenhuma URL passa do limite');
    const lista = listasDaMarcacao(pedidos);
    assert.deepEqual(JSON.parse(new URLSearchParams(lista[0].search).get('query')), { _tags: { $nin: ['alfa'] } });
  });
});

describe('a marcação automática pelo prefixo do PPPoE', () => {
  const tenantRow = async (id) => getDb()('tenants').where({ id }).first();
  const passada = async (id) => runInTenant(id, async () => SchedulerService.runJobs({ tenant: await tenantRow(id) }));

  it('o agendador marca as ONTs novas do provedor e não toca as de outro', async () => {
    const salvo = await api(`/platform/tenants/${alfa}/genieacs`, {
      method: 'PUT', body: { autoTagPrefixes: 'TA100, beta' }
    });
    assert.equal(salvo.status, 200, JSON.stringify(salvo.body));
    assert.deepEqual(salvo.body.data.autoTagPrefixes, ['ta100', 'beta']);

    // No fundo: a volta do agendador não espera a leitura do ACS inteiro.
    const resumo = await passada(alfa);
    assert.equal(resumo.autoTag, 'started');
    await DeviceScopeTagger.idle();
    const ultima = await runInTenant(alfa, () => DeviceScopeTagger.lastAuto());
    assert.equal(ultima.tagged, 1);
    assert.equal(ultima.conflictCount, 1, 'a ONT da beta fica como conflito');
    assert.deepEqual(genie.state.tags, [{ deviceId: 'ONT-SEMDONO', tag: 'alfa', method: 'POST' }]);

    const { body } = await api(`/platform/tenants/${alfa}/genieacs`);
    assert.equal(body.data.lastAutoTag.tagged, 1);

    genie.state.tags.length = 0;
    const segunda = await passada(alfa);
    assert.equal(segunda.autoTag, null, 'dentro de 15 minutos não passa de novo');
    assert.deepEqual(genie.state.tags, []);
  });

  it('lê só serial, login e tags; o ACS devolve só quem não tem a tag ($nin)', async () => {
    // A tag posta fica no documento, como num GenieACS de verdade: é o que a
    // leitura seguinte da beta vê.
    genie.state.applyTags = true;
    await runInTenant(alfa, () => Setting.upsert('deviceScopeAutoPrefixes', 'ta100'));
    await runInTenant(beta, () => Setting.upsert('deviceScopeAutoPrefixes', 'ta100-novo'));
    const antes = genie.state.requests.length;

    const primeira = await runInTenant(alfa, () => DeviceScopeTagger.runAuto());
    assert.equal(primeira.tagged, 1);
    // Cada provedor pergunta pela SUA tag; a beta vê a ONT que a alfa acabou
    // de marcar como dela, e nunca a marca de novo.
    const segunda = await runInTenant(beta, () => DeviceScopeTagger.runAuto());
    assert.equal(segunda.tagged, 0);
    assert.equal(segunda.conflictCount, 1, 'a ONT que a alfa acabou de marcar é conflito para a beta');
    assert.deepEqual(genie.state.tags, [{ deviceId: 'ONT-SEMDONO', tag: 'alfa', method: 'POST' }]);

    const leituras = listasDaMarcacao(genie.state.requests.slice(antes));
    assert.equal(leituras.length, 2, 'uma leitura por provedor, cada uma com a sua tag');
    const [daAlfa, daBeta] = leituras.map((r) => JSON.parse(new URLSearchParams(r.search).get('query')));
    assert.ok(JSON.stringify(daAlfa).includes('{"_tags":{"$nin":["alfa"]}}'), JSON.stringify(daAlfa));
    assert.ok(JSON.stringify(daBeta).includes('{"_tags":{"$nin":["beta"]}}'), JSON.stringify(daBeta));
    assert.ok(JSON.stringify(daAlfa).includes('$regex'), 'o prefixo também vai na busca');
    const projecao = new URLSearchParams(leituras[0].search).get('projection').split(',');
    assert.ok(projecao.includes('_tags') && projecao.includes('_deviceId._SerialNumber'));
    assert.ok(!projecao.some((caminho) => /WLANConfiguration|Optical|Temperature/.test(caminho)),
      `nada da listagem que a marcação não lê: ${projecao.join(',')}`);
  });

  it('a mesma busca dentro de 2 min usa a leitura guardada, e as contas continuam certas', async () => {
    genie.state.applyTags = true;
    const primeira = await runInTenant(alfa, () => DeviceScopeTagger.run({ prefixes: ['ta100'], apply: true, fresh: false }));
    assert.equal(primeira.tagged, 1);
    // Contado ANTES de marcar: o que esta passada marcou está em `toTag`, não nos dois.
    assert.equal(primeira.toTag, 1);
    assert.equal(primeira.alreadyTagged, 0);
    assert.equal(primeira.matched, 1);
    const antes = genie.state.requests.length;
    const segunda = await runInTenant(alfa, () => DeviceScopeTagger.run({ prefixes: ['ta100'], apply: true, fresh: false }));
    assert.equal(listasDaMarcacao(genie.state.requests.slice(antes)).length, 0, 'sem nova leitura da lista');
    assert.equal(segunda.tagged, 0);
    assert.equal(segunda.toTag, 0);
    assert.equal(segunda.alreadyTagged, 1, 'a contagem é ao vivo');
    assert.equal(segunda.matched, 1);
  });

  it('sem prefixo, ou sem tag, não faz nada', async () => {
    const semPrefixo = await passada(alfa);
    assert.equal(semPrefixo.autoTag, null);
    await runInTenant(alfa, () => Setting.upsert('deviceScopeAutoPrefixes', 'ta100'));
    await definirTag(alfa, '');
    const semTag = await passada(alfa);
    assert.equal(semTag.autoTag, null);
    assert.deepEqual(genie.state.tags, []);
  });

  it('o console recusa prefixo sem tag e prefixos que se sobrepõem entre provedores do mesmo ACS', async () => {
    await definirTag(beta, '');
    const semTag = await api(`/platform/tenants/${beta}/genieacs`, { method: 'PUT', body: { autoTagPrefixes: 'TB' } });
    assert.equal(semTag.status, 400);

    await runInTenant(alfa, () => Setting.upsert('deviceScopeAutoPrefixes', 'ta100'));
    const disputa = await api(`/platform/tenants/${beta}/genieacs`, {
      method: 'PUT', body: { deviceTag: 'beta', autoTagPrefixes: ['TA1'] }
    });
    assert.equal(disputa.status, 409);
    const ok = await api(`/platform/tenants/${beta}/genieacs`, {
      method: 'PUT', body: { deviceTag: 'beta', autoTagPrefixes: ['TB'] }
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it('o provedor não grava os próprios prefixos pela tela dele', async () => {
    const { status } = await api('/settings/deviceScopeAutoPrefixes', { method: 'PUT', body: { value: 'x' } });
    assert.notEqual(status, 200);
  });
});
