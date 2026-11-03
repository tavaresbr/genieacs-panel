import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * O backup externo de ponta a ponta: o console configura (sem nenhum segredo
 * voltar), o painel tira o dump, empacota, cifra com a chave PÚBLICA, manda
 * para um S3 de mentira e poda; a verificação semanal pega o arquivo
 * corrompido no bucket; a falha vira alerta `backup_failed`; e o teste de
 * restauração — com a chave privada, que só o teste tem — decifra, confere o
 * manifesto e abre o banco num lugar temporário.
 *
 * SaaS, porque é onde o console existe. As datas são ao segundo (o MySQL
 * arredonda os milissegundos).
 */
process.env.EDITION = 'saas';

const {
  authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const { startFakeS3 } = await import('./helpers/fakeS3.js');
const { default: ExternalBackupService, objectKeyFor } = await import('../src/services/backup/externalBackupService.js');
const { readStatus, effectiveConfig, installId, CONFIG_KEY, INSTALL_ID_KEY, STATUS_KEY } = await import('../src/services/backup/externalBackupSettings.js');
const { LEASE_HOLDER } = await import('../src/services/schedulerLease.js');
const { generateKeyPair } = await import('../src/services/backup/backupCrypto.js');
const { decryptAndExtract, restoreCheck } = await import('../src/services/backup/backupRestore.js');
const { saveProfile, invalidatePlatformProfile } = await import('../src/services/platformProfileService.js');
const { default: PlatformAlertService } = await import('../src/services/platformAlertService.js');
const { default: SecretRotationService } = await import('../src/services/secretRotationService.js');
const { setLogSink } = await import('../src/utils/logger.js');
const { resolveClient } = await import('../src/config/dbConfig.js');

const BUCKET = 'skygp-backups';
const ACCESS = 'AKIAEXTERNALBKP9876';
const SECRET = 'segredo-do-s3/nao+pode+vazar=XYZ';
const ehSqlite = resolveClient() === 'better-sqlite3';

let panelUrl;
let token;
let comumToken;
let fake;
let par;
let linhasDeLog = [];
let base;

const platform = (caminho, options = {}, t = token) => call(`${panelUrl}/api/platform${caminho}`, {
  ...options, headers: { ...authHeaders(t), ...(options.headers || {}) }
});
const esperar = async () => {
  while (ExternalBackupService.current) {
    // eslint-disable-next-line no-await-in-loop
    await ExternalBackupService.current;
  }
};
const alertasDeBackup = () => getDb()('platform_alerts').where({ event: 'backup_failed' }).orderBy('id');

async function configurar(extra = {}) {
  const r = await platform('/integrations/backup', {
    method: 'PUT',
    body: {
      endpoint: fake.url, region: 'us-east-1', bucket: BUCKET, prefix: 'painel/', forcePathStyle: true,
      accessKeyId: ACCESS, secretAccessKey: SECRET, enabled: true, runner: 'panel', hour: 0, keepDaily: 3, keepWeekly: 1,
      ...extra
    }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const db = getDb();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });

  // Um administrador do provedor, sem papel na plataforma.
  const convite = await call(`${panelUrl}/api/users`, {
    method: 'POST', headers: authHeaders(token),
    body: { username: 'admin-comum', password: 'comum-senha-1', email: 'comum@exemplo.test', role: 'admin' }
  });
  if (convite.status === 201) {
    const login = await call(`${panelUrl}/api/auth/login`, { method: 'POST', body: { username: 'admin-comum', password: 'comum-senha-1' } });
    comumToken = login.body?.data?.token ?? null;
  }

  fake = await startFakeS3({ bucket: BUCKET, accessKeyId: ACCESS, secretAccessKey: SECRET, pageSize: 2 });
  par = generateKeyPair();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-extbk-test-'));
  process.env.SKYGP_BACKUP_TMP = path.join(base, 'tmp');
  invalidatePlatformProfile();
  await saveProfile({ notifyEmail: 'ops@plataforma.test' });
  await saveProfile({ alerts: { events: { backup_failed: { enabled: true, channels: ['email'] } } } });
  invalidatePlatformProfile();
  setLogSink((linha) => linhasDeLog.push(String(linha)));
});

after(async () => {
  setLogSink(null);
  await esperar();
  await fake.close();
  await stopTestServers();
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(async () => {
  await esperar();
  fake.fail = null;
  ExternalBackupService.lastPassAt = 0;
});

describe('a configuração pelo console', () => {
  it('só para quem é da plataforma', async () => {
    const sem = await call(`${panelUrl}/api/platform/integrations/backup`);
    assert.ok([401, 403].includes(sem.status));
    if (comumToken) {
      const comum = await platform('/integrations/backup', {}, comumToken);
      assert.ok([403, 404].includes(comum.status));
    }
  });

  it('começa não configurada; grava sem devolver a secret, e com a access key mascarada', async () => {
    const vazio = await platform('/integrations/backup');
    assert.equal(vazio.status, 200);
    assert.equal(vazio.body.data.configured, false);

    const r = await configurar();
    const texto = JSON.stringify(r.body);
    assert.ok(!texto.includes(SECRET), 'a secret voltou na resposta');
    assert.ok(!texto.includes(ACCESS), 'a access key voltou inteira na resposta');
    assert.equal(r.body.data.accessKeyIdHint, '••••9876');
    assert.equal(r.body.data.secretAccessKeyConfigured, true);
    assert.equal(r.body.data.bucket, BUCKET);
    assert.equal(r.body.data.configured, false, 'sem chave pública ainda não está pronto');

    // No banco, a conexão inteira vai cifrada: nem a secret nem o bucket em claro.
    const linha = await getDb()('app_state').where({ key: CONFIG_KEY }).first();
    assert.ok(!linha.value.includes(SECRET));
    assert.ok(!linha.value.includes(ACCESS));
    assert.ok(!linha.value.includes(BUCKET));
    assert.ok(JSON.parse(linha.value).connection.password_ciphertext);

    // A trilha diz o que mudou, sem valor.
    const trilha = await getDb()('platform_audit').where({ action: 'platform.integration_changed' }).orderBy('id', 'desc').first();
    assert.ok(trilha, 'sem linha na trilha');
    assert.ok(!JSON.stringify(trilha).includes(SECRET));
    assert.ok(!JSON.stringify(trilha).includes(ACCESS));
    assert.match(trilha.detail, /secretAccessKey/);

    // Reenviar o formulário sem a secret não a apaga.
    const de_novo = await platform('/integrations/backup', { method: 'PUT', body: { bucket: BUCKET, hour: 2 } });
    assert.equal(de_novo.body.data.secretAccessKeyConfigured, true);
    assert.equal(de_novo.body.data.hour, 2);
    assert.equal((await effectiveConfig()).connection.secretAccessKey, SECRET);
  });

  it('valida o que recebe', async () => {
    for (const corpo of [{ endpoint: 'ftp://x' }, { endpoint: 'https://u:p@host' }, { bucket: 'A' }, { hour: 24 }, { runner: 'cron' }, { keepDaily: 0 }]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await platform('/integrations/backup', { method: 'PUT', body: corpo });
      assert.equal(r.status, 400, JSON.stringify(corpo));
    }
  });

  it('a chave pública: recusa a que não é X25519, guarda a boa; o par do servidor devolve a privada uma vez e não a guarda', async () => {
    const ruim = await platform('/integrations/backup/public-key', { method: 'POST', body: { publicKey: 'nada' } });
    assert.equal(ruim.status, 400);
    assert.equal(ruim.body.code, 'invalid_public_key');

    const servidor = await platform('/integrations/backup/keypair', { method: 'POST' });
    assert.equal(servidor.status, 200);
    assert.match(servidor.body.data.privateKeyPem, /BEGIN PRIVATE KEY/);
    assert.equal(servidor.body.data.settings.keyOrigin, 'server');
    const guardado = await getDb()('app_state').where({ key: CONFIG_KEY }).first();
    assert.ok(!guardado.value.includes('PRIVATE KEY'));
    assert.ok(!guardado.value.includes(servidor.body.data.privateKeyPem.split('\n')[1]));

    // A do teste é a que vale daqui em diante — como se viesse do navegador.
    const boa = await platform('/integrations/backup/public-key', { method: 'POST', body: { publicKey: par.publicKey, origin: 'browser' } });
    assert.equal(boa.status, 200);
    assert.equal(boa.body.data.keyId, par.keyId);
    assert.equal(boa.body.data.keyOrigin, 'browser');
    assert.equal(boa.body.data.configured, true);
    const trilha = await getDb()('platform_audit').where({ action: 'platform.backup_key_changed' }).orderBy('id', 'desc').first();
    assert.match(trilha.detail, new RegExp(par.keyId));
  });

  it('o teste de conexão: HeadBucket, um objeto posto e apagado; a credencial errada responde ok: false', async () => {
    const r = await platform('/integrations/backup/test', { method: 'POST' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.ok, true, JSON.stringify([r.body, fake.rejections]));
    assert.deepEqual(r.body.data.steps, { headBucket: true, put: true, delete: true });
    assert.equal([...fake.objects.keys()].filter((k) => k.includes('connection-test')).length, 0);

    await platform('/integrations/backup', { method: 'PUT', body: { secretAccessKey: 'outra-secret-errada' } });
    const errado = await platform('/integrations/backup/test', { method: 'POST' });
    assert.equal(errado.body.data.ok, false);
    assert.match(errado.body.data.error, /403 AccessDenied/);
    assert.ok(!JSON.stringify(errado.body).includes('outra-secret-errada'));
    await configurar();
  });

  it('a conexão entra na rotação da chave da caixa de segredos', () => {
    assert.ok(SecretRotationService.BLOBS.some((b) => b.chave === CONFIG_KEY && b.contexto === 'skygenpanel-external-backup-v1'));
  });

  it('o Deployment mostra o backup externo como configurado', async () => {
    const r = await platform('/deployment');
    assert.equal(r.body.data.configured.externalBackup, true);
  });
});

describe('o backup, o envio e a poda', () => {
  it('"Fazer backup agora": tira, cifra, envia com o sha256 nos metadados, e registra', async () => {
    // Cinco backups velhos desta instalação, os mesmos dias de OUTRA
    // instalação no mesmo prefixo, um sem identidade e um objeto de outra pessoa.
    const minha = await installId();
    assert.match(minha, /^[0-9a-f]{12}$/);
    assert.equal(await installId(), minha, 'a identidade mudou entre duas leituras');
    const outra = minha === '0123456789ab' ? 'ba9876543210' : '0123456789ab';
    const dias = ['2025-12-20', '2025-12-21', '2026-01-01', '2026-01-02', '2026-01-03'];
    for (const dia of dias) {
      fake.objects.set(objectKeyFor('painel/', `${dia}T031700Z`, minha), { body: Buffer.from('velho'), metadata: {} });
      fake.objects.set(objectKeyFor('painel/', `${dia}T031700Z`, outra), { body: Buffer.from('alheio'), metadata: {} });
    }
    fake.objects.set(objectKeyFor('painel/', '2025-12-20T031700Z'), { body: Buffer.from('sem-id'), metadata: {} });
    fake.objects.set('painel/nao-e-nosso.txt', { body: Buffer.from('x'), metadata: {} });

    const r = await platform('/integrations/backup/run', { method: 'POST' });
    assert.equal(r.status, 202);
    const ocupado = await platform('/integrations/backup/run', { method: 'POST' });
    assert.equal(ocupado.status, 409);
    assert.equal(ocupado.body.code, 'busy');
    await esperar();

    const { lastRun, lastSuccess } = await readStatus();
    assert.equal(lastRun.status, 'ok', JSON.stringify(lastRun));
    assert.equal(lastSuccess.key, lastRun.key);
    const objeto = fake.objects.get(lastRun.key);
    assert.ok(objeto, 'o arquivo não chegou ao bucket');
    assert.equal(objeto.metadata['skygp-sha256'], crypto.createHash('sha256').update(objeto.body).digest('hex'));
    assert.equal(objeto.metadata['skygp-key-id'], par.keyId);
    assert.equal(objeto.metadata['skygp-install-id'], minha);
    assert.ok(lastRun.key.endsWith(`-${minha}.tar.skygpbk`), lastRun.key);
    assert.equal(lastRun.bytes, objeto.body.length);
    assert.equal(objeto.body.subarray(0, 7).toString(), 'SKYGPBK');

    // keepDaily 3, keepWeekly 1: hoje, 03/01 e 02/01 pelos dias; 01/01 pela
    // semana dele; a semana de dezembro sai inteira. O de outra pessoa fica.
    assert.ok(fake.objects.has('painel/nao-e-nosso.txt'));
    assert.equal(lastRun.deleted, 2);
    assert.equal(fake.objects.has(objectKeyFor('painel/', '2026-01-01T031700Z', minha)), true);
    assert.equal(fake.objects.has(objectKeyFor('painel/', '2025-12-21T031700Z', minha)), false);
    assert.equal(fake.objects.has(objectKeyFor('painel/', '2025-12-20T031700Z', minha)), false);
    // Os da outra instalação e o sem identidade ficam todos.
    for (const dia of dias) assert.ok(fake.objects.has(objectKeyFor('painel/', `${dia}T031700Z`, outra)), dia);
    assert.ok(fake.objects.has(objectKeyFor('painel/', '2025-12-20T031700Z')));
    // E a verificação olha para o desta instalação, não para o de outra.
    const listados = await ExternalBackupService.listBackups();
    assert.ok(listados.every((o) => o.installId === minha));
    assert.equal(listados[0].key, lastRun.key);
    assert.ok((await ExternalBackupService.listBackups(null, { allInstalls: true })).some((o) => o.installId === outra));

    const tela = await platform('/integrations/backup');
    assert.equal(tela.body.data.status.lastRun.status, 'ok');
    assert.equal(tela.body.data.running, false);
    const trilha = await getDb()('platform_audit').where({ action: 'platform.backup_requested' }).first();
    assert.ok(trilha);
  });

  it('a restauração com a chave privada: decifra, confere o manifesto e abre o banco num lugar temporário', async () => {
    const { lastSuccess } = await readStatus();
    const arquivo = path.join(base, 'restore.skygpbk');
    fs.writeFileSync(arquivo, fake.objects.get(lastSuccess.key).body);
    const dir = await decryptAndExtract({ encryptedFile: arquivo, privateKey: par.privateKeyPem, destino: path.join(base, 'rst') });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    const topo = (await getDb()('schema_migrations').orderBy('id', 'desc').first()).id;
    assert.equal(manifest.schemaMigration, topo);
    assert.equal(manifest.source, 'panel');
    if (ehSqlite) {
      const r = await restoreCheck(dir);
      assert.equal(r.ok, true);
      assert.equal(r.schemaMigration, topo);
      assert.ok(r.tables > 20, `só ${r.tables} tabelas`);
      assert.ok(r.files.includes('panel.sqlite'));
    }
    // Com a chave errada, nada sai.
    await assert.rejects(
      decryptAndExtract({ encryptedFile: arquivo, privateKey: generateKeyPair().privateKeyPem, destino: path.join(base, 'rst2') }),
      /encrypted for key/
    );
  });

  it('a verificação passa no arquivo bom e aponta o corrompido no bucket — e o corrompido vira alerta', async () => {
    await getDb()('platform_alerts').del();
    const ok = await ExternalBackupService.verifyLatest({ trigger: 'manual' });
    assert.equal(ok.status, 'ok', JSON.stringify(ok));
    assert.equal(ok.keyMatches, true);

    const { lastSuccess } = await readStatus();
    const objeto = fake.objects.get(lastSuccess.key);
    const estragado = Buffer.from(objeto.body);
    estragado[estragado.length - 100] ^= 0xff;
    fake.objects.set(lastSuccess.key, { ...objeto, body: estragado });
    const ruim = await ExternalBackupService.verifyLatest({ trigger: 'manual' });
    assert.equal(ruim.status, 'failed');
    assert.equal(ruim.code, 'checksum_mismatch');
    assert.equal((await readStatus()).lastVerification.status, 'failed');
    const alertas = await alertasDeBackup();
    assert.equal(alertas.length, 1);
    assert.match(alertas[0].payload, /verify/);
    fake.objects.set(lastSuccess.key, objeto);

    // Truncado também.
    fake.objects.set(lastSuccess.key, { ...objeto, body: objeto.body.subarray(0, objeto.body.length - 7) });
    const curto = await ExternalBackupService.verifyLatest({ trigger: 'manual' });
    assert.equal(curto.status, 'failed');
    fake.objects.set(lastSuccess.key, objeto);
  });

  it('a falha do envio vira backup_failed, sem credencial nem no alerta nem no log', async () => {
    await getDb()('platform_alerts').del();
    linhasDeLog = [];
    fake.fail = (req) => (req.method === 'PUT' ? 500 : null);
    const r = await ExternalBackupService.perform({ trigger: 'manual' });
    fake.fail = null;
    assert.equal(r.status, 'failed');
    assert.match(r.error, /S3 answered 500/);
    assert.equal((await readStatus()).lastRun.status, 'failed');
    const alertas = await alertasDeBackup();
    assert.equal(alertas.length, 1);
    assert.match(alertas[0].payload, /"source":"panel"/);
    const tudo = JSON.stringify(alertas) + linhasDeLog.join('\n') + JSON.stringify(await readStatus());
    assert.ok(linhasDeLog.some((l) => l.includes('external backup failed')));
    assert.ok(!tudo.includes(SECRET), 'a secret apareceu');
    assert.ok(!tudo.includes(ACCESS), 'a access key apareceu');
    // O alerta renderiza com a etapa e o erro.
    const { subject, text } = await import('../src/services/platformAlertService.js').then((m) => m.renderAlert(alertas[0]));
    assert.ok(subject.length > 0);
    assert.match(text, /S3 answered 500/);
  });
});

describe('o agendador', () => {
  it('uma passada por dia, mesmo com duas instâncias disputando', async () => {
    await getDb()('app_state').where({ key: STATUS_KEY }).del();
    const antes = fake.requests.filter((q) => q.method === 'PUT' && !q.query.partNumber).length;
    const agora = new Date(Math.floor(Date.now() / 1000) * 1000);
    const [a, b] = await Promise.all([
      ExternalBackupService.perform({ trigger: 'schedule', now: agora }),
      ExternalBackupService.perform({ trigger: 'schedule', now: agora })
    ]);
    const status = [a.status, b.status].sort();
    assert.deepEqual(status, ['ok', 'skipped'], JSON.stringify([a, b]));
    assert.equal([a, b].find((x) => x.status === 'skipped').reason, 'other_instance');
    // E a mesma instância, depois, não repete o do dia.
    const c = await ExternalBackupService.perform({ trigger: 'schedule', now: agora });
    assert.equal(c.reason, 'already_ran');
    const depois = fake.requests.filter((q) => q.method === 'PUT' && !q.query.partNumber).length;
    assert.equal(depois - antes, 1);
  });

  it('schedulerPass começa o backup do dia à hora escolhida, e depois a verificação semanal', async () => {
    await getDb()('app_state').where({ key: STATUS_KEY }).del();
    const agora = new Date(Math.floor(Date.now() / 1000) * 1000);
    const r = await ExternalBackupService.schedulerPass({ now: agora, force: true });
    assert.equal(r.started, 'backup');
    await esperar();
    assert.equal((await readStatus()).lastRun.status, 'ok');
    const v = await ExternalBackupService.schedulerPass({ now: agora, force: true });
    assert.equal(v.started, 'verify');
    await esperar();
    assert.equal((await readStatus()).lastVerification.status, 'ok');
    assert.equal((await ExternalBackupService.schedulerPass({ now: agora, force: true })).skipped, 'nothing_due');

    // Com o host como quem roda, o painel não tira o backup.
    await configurar({ runner: 'host' });
    await getDb()('app_state').where({ key: STATUS_KEY }).del();
    assert.equal((await ExternalBackupService.schedulerPass({ now: agora, force: true })).skipped, 'nothing_due');
    await configurar();
  });
});

describe('a vez durante um envio longo', () => {
  it('é renovada enquanto o envio dura, e devolvida no fim', async () => {
    const chaveDaVez = 'lease:external-backup';
    const lerVez = async () => {
      const linha = await getDb()('app_state').where({ key: chaveDaVez }).first();
      return linha ? JSON.parse(linha.value) : null;
    };
    const vistas = [];
    const intervaloOriginal = ExternalBackupService.leaseHeartbeatMs;
    const opcoesOriginais = ExternalBackupService.clientOptions;
    ExternalBackupService.leaseHeartbeatMs = 40;
    // O PUT do arquivo demora: o tempo de várias renovações.
    ExternalBackupService.clientOptions = {
      ...opcoesOriginais,
      fetchImpl: async (url, init) => {
        if (init?.method === 'PUT') {
          for (let i = 0; i < 6; i += 1) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => { setTimeout(resolve, 60); });
            // eslint-disable-next-line no-await-in-loop
            vistas.push(await lerVez());
          }
        }
        return fetch(url, init);
      }
    };
    // A vez tomada "há cinco horas e meia": sem renovar, venceria no meio.
    const inicio = new Date(Date.now() - 5.5 * 3600_000);
    try {
      const r = await ExternalBackupService.perform({ trigger: 'manual', now: inicio });
      assert.equal(r.status, 'ok', JSON.stringify(r));
    } finally {
      ExternalBackupService.leaseHeartbeatMs = intervaloOriginal;
      ExternalBackupService.clientOptions = opcoesOriginais;
    }
    const tomada = inicio.getTime() + 6 * 3600_000;
    const renovadas = vistas.filter((v) => v && v.holder === LEASE_HOLDER && Number(v.until) > tomada);
    assert.ok(renovadas.length >= 1, `a vez não foi renovada: ${JSON.stringify(vistas)}`);
    assert.ok(Number(renovadas.at(-1).until) > Date.now() + 5 * 3600_000);
    assert.equal(await lerVez(), null, 'a vez não foi devolvida no fim');
  });

  it('não rouba a vez de volta se outra instância a tomou', async () => {
    const { acquireLease, renewLease } = await import('../src/services/schedulerLease.js');
    assert.equal(await acquireLease('teste-renovar', { ttlMs: 1000, holder: 'a' }), true);
    assert.equal(await renewLease('teste-renovar', { ttlMs: 60_000, holder: 'a' }), true);
    assert.equal(await renewLease('teste-renovar', { ttlMs: 60_000, holder: 'b' }), false);
    const linha = await getDb()('app_state').where({ key: 'lease:teste-renovar' }).first();
    assert.equal(JSON.parse(linha.value).holder, 'a');
  });

  it('a identidade da instalação é gravada uma vez só', async () => {
    const id = await installId();
    const linhas = await getDb()('app_state').where({ key: INSTALL_ID_KEY });
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].value, id);
  });
});

describe('o host', () => {
  it('envia um backup tirado pelo script, e a falha do systemd vira um alerta só (aviso direto + marcador)', async () => {
    const stamp = '2026-11-02T031700Z';
    const dir = path.join(base, 'host', stamp);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'panel.sqlite'), 'x');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ client: 'better-sqlite3', schemaMigration: '0001' }));
    const r = await ExternalBackupService.perform({ trigger: 'host', sourceDir: dir });
    assert.equal(r.status, 'ok', JSON.stringify(r));
    assert.equal(r.key, objectKeyFor('painel/', stamp, await installId()));
    assert.equal(r.source, 'host');

    await getDb()('platform_alerts').del();
    const agora = new Date(Math.floor(Date.now() / 1000) * 1000);
    const direto = await ExternalBackupService.recordHostFailure({ reason: 'pg_dump: connection refused', now: agora });
    assert.equal(direto.enqueued, true);
    assert.match((await readStatus()).hostFailure.reason, /connection refused/);
    // O marcador que o `notify-failure` grava ao lado dos backups: o mesmo
    // dia, a mesma chave — não vira um segundo alerta.
    const destino = path.join(base, 'host');
    fs.writeFileSync(path.join(destino, '.last-failure'), JSON.stringify({ reason: 'pg_dump: connection refused' }));
    fs.utimesSync(path.join(destino, '.last-failure'), agora, agora);
    fs.utimesSync(path.join(dir, 'manifest.json'), new Date(agora.getTime() - 60_000), new Date(agora.getTime() - 60_000));
    const marcador = await PlatformAlertService.checkBackupFailure({ now: agora, dir: destino });
    assert.equal(marcador.checked, true);
    assert.equal(marcador.enqueued, 0);
    assert.equal((await alertasDeBackup()).length, 1);

    // Sem o aviso direto (o banco caiu junto), o marcador sozinho avisa.
    await getDb()('platform_alerts').del();
    const sozinho = await PlatformAlertService.checkBackupFailure({ now: agora, dir: destino });
    assert.equal(sozinho.enqueued, 1);
    // E um backup mais novo que o marcador o desarma.
    fs.utimesSync(path.join(dir, 'manifest.json'), new Date(agora.getTime() + 60_000), new Date(agora.getTime() + 60_000));
    await getDb()('platform_alerts').del();
    assert.equal((await PlatformAlertService.checkBackupFailure({ now: agora, dir: destino })).enqueued, 0);
  });
});

describe('a CLI do restore (o que se roda no dia, com a chave privada)', () => {
  it('restore --file decifra, confere e abre o banco num lugar temporário; a chave errada sai com código 1', { skip: !ehSqlite }, async () => {
    // Um backup do painel de agora (o último do bloco anterior é o do host,
    // com um banco de mentira dentro).
    const feito = await ExternalBackupService.perform({ trigger: 'manual' });
    assert.equal(feito.status, 'ok', JSON.stringify(feito));
    const { lastSuccess } = await readStatus();
    const arquivo = path.join(base, 'cli.skygpbk');
    fs.writeFileSync(arquivo, fake.objects.get(lastSuccess.key).body);
    const chave = path.join(base, 'privada.pem');
    fs.writeFileSync(chave, par.privateKeyPem, { mode: 0o600 });
    const cli = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), 'scripts', 'backup-external.js');
    const ok = spawnSync(process.execPath, [cli, 'restore', '--file', arquivo, '--private-key', chave], { encoding: 'utf8', env: process.env });
    assert.equal(ok.status, 0, ok.stderr);
    const relatorio = JSON.parse(ok.stdout);
    assert.equal(relatorio.ok, true);
    assert.equal(relatorio.schemaMigration, (await getDb()('schema_migrations').orderBy('id', 'desc').first()).id);

    const outra = path.join(base, 'outra.pem');
    fs.writeFileSync(outra, generateKeyPair().privateKeyPem, { mode: 0o600 });
    const ruim = spawnSync(process.execPath, [cli, 'restore', '--file', arquivo, '--private-key', outra], { encoding: 'utf8', env: process.env });
    assert.equal(ruim.status, 1);
    assert.match(ruim.stderr, /encrypted for key/);
  });
});

