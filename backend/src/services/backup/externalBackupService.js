import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { log } from '../../utils/logger.js';
import { acquireLease, releaseLease } from '../schedulerLease.js';
import PlatformAlertService, { saoPauloClock } from '../platformAlertService.js';
import { HEADER_BYTES, createEncryptStream, inspectEncrypted, parseHeader, parsePublicKey } from './backupCrypto.js';
import { S3Client, S3Error, hashingStream } from './s3Client.js';
import { packDirectory } from './tarArchive.js';
import { BackupError, createLocalBackup, stampOf } from './localBackup.js';
import { effectiveConfig, readStatus, writeStatus } from './externalBackupSettings.js';

/**
 * O backup externo: tirar, empacotar, cifrar, enviar, podar — e conferir.
 *
 * ## Dois lugares de onde roda, uma conta só
 *
 * - **Docker/SaaS**: o agendador da plataforma chama `schedulerPass` a cada
 *   minuto; à hora escolhida (Brasília) o painel tira o próprio dump
 *   (`localBackup.js`), sob a vez `external-backup` (`schedulerLease`) para
 *   duas instâncias não mandarem dois arquivos.
 * - **Host (systemd)**: o `skygenpanel-backup run` tira o dump como sempre, e
 *   o `upload` seguinte chama `scripts/backup-external.js upload`, que chega
 *   aqui com o diretório pronto (`sourceDir`). A configuração é a mesma,
 *   gravada pelo console: o operador configura uma vez.
 *
 * Qual dos dois manda é o `runner` da configuração — os dois juntos subiriam
 * dois arquivos por dia.
 *
 * ## A verificação semanal, e o limite dela
 *
 * O servidor NÃO tem a chave privada — é o ponto. Então a verificação que ele
 * consegue fazer sozinho é a da integridade do que está no bucket: baixa o
 * último arquivo, confere o sha256 do arquivo CIFRADO contra o que foi gravado
 * no envio (metadado `skygp-sha256` e o estado), lê o cabeçalho e confere que
 * o tamanho fecha com o desenho dos pedaços. Isso pega o arquivo corrompido,
 * truncado ou trocado no bucket. O que ela não prova é que o conteúdo
 * decifra e restaura — isso exige a privada, e é o
 * `skygenpanel-backup restore --from-s3 <chave> --private-key <arquivo>`
 * documentado em docs/saas-operations.md, que restaura num banco TEMPORÁRIO e
 * confere o ledger.
 */

export const OBJECT_SUFFIX = '.tar.skygpbk';
const NOME = /(?:^|\/)skygp-backup-(\d{4}-\d{2}-\d{2}T\d{6}Z)\.tar\.skygpbk$/;
const LEASE = 'external-backup';
const LEASE_TTL_MS = 6 * 3600_000;
const VERIFY_EVERY_MS = 7 * 24 * 3600_000;
const PASS_INTERVAL_MS = 60_000;

/** Onde o dump e o arquivo cifrado ficam até o envio (`SKYGP_BACKUP_TMP`, ou o tmp do sistema). */
function pastaTemporaria(rotulo) {
  const base = process.env.SKYGP_BACKUP_TMP || os.tmpdir();
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  const pasta = fs.mkdtempSync(path.join(base, rotulo));
  fs.chmodSync(pasta, 0o700);
  return pasta;
}

/** O texto de um erro, sem nenhum dos segredos da conexão dentro. */
export function redact(texto, config) {
  let saida = String(texto ?? '');
  const segredos = [config?.connection?.secretAccessKey, config?.connection?.accessKeyId].filter((s) => s && s.length >= 4);
  for (const s of segredos) saida = saida.split(s).join('[REDACTED]');
  return saida.slice(0, 500);
}

export function objectKeyFor(prefix, stamp) {
  return `${prefix || ''}skygp-backup-${stamp}${OBJECT_SUFFIX}`;
}

/** O carimbo de uma chave nossa, ou nulo para qualquer outro objeto. */
export function stampOfKey(key, prefix = '') {
  if (prefix && !key.startsWith(prefix)) return null;
  const resto = key.slice(prefix.length);
  if (resto.includes('/')) return null;
  const m = resto.match(NOME);
  return m ? m[1] : null;
}

function diaDoCarimbo(stamp) {
  return stamp.slice(0, 10);
}

/** A segunda-feira da semana (UTC) de um dia `AAAA-MM-DD`. */
function semanaDe(dia) {
  const d = new Date(`${dia}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - dow * 86_400_000).toISOString().slice(0, 10);
}

/**
 * O que a retenção mantém: o mais novo de cada um dos `keepDaily` dias mais
 * recentes, e o mais novo de cada uma das `keepWeekly` semanas anteriores a
 * eles. O mais novo de todos, sempre. Só olha para os NOSSOS objetos — um
 * arquivo de outra pessoa no mesmo prefixo nunca é apagado.
 */
export function planRetention(objetos, { prefix = '', keepDaily, keepWeekly }) {
  const nossos = objetos
    .map((o) => ({ ...o, stamp: stampOfKey(o.key, prefix) }))
    .filter((o) => o.stamp)
    .sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
  const manter = new Set();
  if (nossos.length) manter.add(nossos[0].key);
  const dias = new Set();
  for (const o of nossos) {
    const dia = diaDoCarimbo(o.stamp);
    if (dias.has(dia)) continue;
    if (dias.size >= keepDaily) break;
    dias.add(dia);
    manter.add(o.key);
  }
  const semanas = new Set();
  for (const o of nossos) {
    const dia = diaDoCarimbo(o.stamp);
    if (dias.has(dia)) continue;
    const semana = semanaDe(dia);
    if (semanas.has(semana)) continue;
    if (semanas.size >= keepWeekly) break;
    semanas.add(semana);
    manter.add(o.key);
  }
  return {
    keep: nossos.filter((o) => manter.has(o.key)).map((o) => o.key),
    remove: nossos.filter((o) => !manter.has(o.key)).map((o) => o.key)
  };
}

class ExternalBackupService {
  /** A passada em andamento neste processo (backup ou verificação), ou nula. */
  static current = null;
  static lastPassAt = 0;
  /** Trocável nos testes: o `fetch` e os tetos do multipart. */
  static clientOptions = {};

  static client(config) {
    return new S3Client({ ...config.connection, ...this.clientOptions });
  }

  /** Começa uma passada em segundo plano, se não houver outra. */
  static start(fn) {
    if (this.current) return false;
    this.current = Promise.resolve()
      .then(fn)
      .catch((error) => {
        log.warn('external backup pass failed', { err: { message: error?.message } });
      })
      .finally(() => {
        this.current = null;
      });
    return true;
  }

  /** Avisa quem opera, pelos alertas da plataforma (`backup_failed`). Nunca lança. */
  static async alertFailure({ stage, source, error, now = new Date() }) {
    const { day } = saoPauloClock(now);
    return PlatformAlertService.enqueue('backup_failed', {
      dedupeKey: `${stage}:${source}:${day}`,
      payload: { stage, source, error: String(error ?? '').slice(0, 300), date: day },
      now
    });
  }

  /**
   * Um backup completo. Nunca lança: devolve `{ status, ... }` e grava o
   * mesmo em `lastRun`.
   *
   * @param {object} opts
   * @param {'manual'|'schedule'|'host'} opts.trigger
   * @param {string} [opts.sourceDir] um backup já tirado (o do host); sem ele, o dump é feito aqui
   */
  static async perform({ trigger = 'manual', sourceDir = null, now = new Date() } = {}) {
    const inicio = Date.now();
    const config = await effectiveConfig();
    const source = trigger === 'host' ? 'host' : 'panel';
    if (!config.configured) {
      return { status: 'skipped', reason: 'not_configured' };
    }
    const minha = await acquireLease(LEASE, { ttlMs: LEASE_TTL_MS, now }).catch(() => false);
    if (!minha) return { status: 'skipped', reason: 'other_instance' };

    const { day } = saoPauloClock(now);
    let trabalho = null;
    try {
      // Relido DEPOIS de tomar a vez: outra instância pode ter rodado o do dia
      // entre a leitura do agendador e este ponto.
      if (trigger === 'schedule' && (await readStatus()).lastAttemptDay === day) {
        return { status: 'skipped', reason: 'already_ran' };
      }
      const startedAt = new Date(inicio).toISOString();
      // Só a passada AGENDADA marca o dia: um "fazer agora" de madrugada não
      // pode tirar o backup das 3h do mesmo dia.
      await writeStatus({
        ...(trigger === 'schedule' ? { lastAttemptDay: day } : {}),
        lastRun: { status: 'running', trigger, source, startedAt }
      });

      trabalho = pastaTemporaria('skygp-extbk-');
      let dir = sourceDir;
      let stamp;
      if (dir) {
        stamp = path.basename(dir);
        if (!/^\d{4}-\d{2}-\d{2}T\d{6}Z$/.test(stamp)) stamp = stampOf(now);
        if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
          throw new BackupError(`${dir} has no manifest.json: it is not a finished backup`, 'invalid_source');
        }
      } else {
        stamp = stampOf(now);
        dir = path.join(trabalho, stamp);
        await createLocalBackup({ destino: dir, includeMedia: config.includeMedia, now });
      }
      let manifest = {};
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
      } catch {
        manifest = {};
      }

      const cifrado = path.join(trabalho, `skygp-backup-${stamp}${OBJECT_SUFFIX}`);
      const conta = hashingStream();
      await pipeline(
        packDirectory(dir, stamp),
        createEncryptStream(parsePublicKey(config.publicKey)),
        conta,
        fs.createWriteStream(cifrado, { mode: 0o600 })
      );
      const { sha256, bytes } = conta.result();

      const key = objectKeyFor(config.connection.prefix, stamp);
      const cliente = this.client(config);
      const envio = await cliente.putObject(key, {
        filePath: cifrado,
        metadata: {
          'skygp-sha256': sha256,
          'skygp-key-id': config.keyId,
          'skygp-format': '1',
          'skygp-schema': String(manifest.schemaMigration ?? 'unknown').slice(0, 100)
        }
      });

      let deleted = 0;
      let retentionError = null;
      try {
        const plano = planRetention(await cliente.listObjects(config.connection.prefix), {
          prefix: config.connection.prefix, keepDaily: config.keepDaily, keepWeekly: config.keepWeekly
        });
        for (const velho of plano.remove) {
          if (velho === key) continue;
          // eslint-disable-next-line no-await-in-loop -- poucos por dia
          await cliente.deleteObject(velho);
          deleted += 1;
        }
      } catch (error) {
        // A poda falhar não desfaz o envio: o arquivo de hoje está lá. Fica
        // registrado, e a próxima passada tenta de novo.
        retentionError = redact(error.message, config);
      }

      const resultado = {
        status: 'ok',
        trigger,
        source,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - inicio,
        key,
        bytes,
        sha256,
        keyId: config.keyId,
        multipart: Boolean(envio.multipart),
        schemaMigration: manifest.schemaMigration ?? null,
        deleted,
        retentionError,
        error: null
      };
      await writeStatus({ lastRun: resultado, lastSuccess: resultado, ...(source === 'host' ? { hostFailure: null } : {}) });
      log.info('external backup uploaded', { key, bytes, durationMs: resultado.durationMs, deleted });
      return resultado;
    } catch (error) {
      const mensagem = redact(error?.message || 'unknown error', config);
      const code = error instanceof BackupError || error instanceof S3Error ? error.code : 'backup_failed';
      const resultado = {
        status: 'failed',
        trigger,
        source,
        startedAt: new Date(inicio).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - inicio,
        error: mensagem,
        code
      };
      await writeStatus({ lastRun: resultado }).catch(() => {});
      log.warn('external backup failed', { code, error: mensagem });
      await this.alertFailure({ stage: 'backup', source, error: mensagem, now });
      return resultado;
    } finally {
      if (trabalho) fs.rmSync(trabalho, { recursive: true, force: true });
      await releaseLease(LEASE).catch(() => {});
    }
  }

  /** Os nossos objetos no bucket, do mais novo para o mais velho. */
  static async listBackups(config = null) {
    const cfg = config ?? await effectiveConfig();
    const objetos = await this.client(cfg).listObjects(cfg.connection.prefix);
    return objetos
      .map((o) => ({ ...o, stamp: stampOfKey(o.key, cfg.connection.prefix) }))
      .filter((o) => o.stamp)
      .sort((a, b) => (a.stamp < b.stamp ? 1 : -1));
  }

  /**
   * A verificação do último arquivo no bucket — sem a chave privada (ver o
   * topo). Nunca lança; grava em `lastVerification`.
   */
  static async verifyLatest({ trigger = 'manual', now = new Date(), key = null } = {}) {
    const config = await effectiveConfig();
    if (!config.configured) return { status: 'skipped', reason: 'not_configured' };
    const minha = await acquireLease(LEASE, { ttlMs: LEASE_TTL_MS, now }).catch(() => false);
    if (!minha) return { status: 'skipped', reason: 'other_instance' };
    const inicio = Date.now();
    let trabalho = null;
    let alvo = key;
    try {
      const cliente = this.client(config);
      let listado = null;
      if (!alvo) {
        [listado] = await this.listBackups(config);
        if (!listado) throw new BackupError('There is no backup in the bucket to verify', 'no_backup');
        alvo = listado.key;
      }
      const cabeca = await cliente.headObject(alvo);
      if (!cabeca) throw new BackupError(`${alvo} is not in the bucket`, 'not_found');

      trabalho = pastaTemporaria('skygp-extvf-');
      const arquivo = path.join(trabalho, 'download');
      const baixado = await cliente.getObjectToFile(alvo, arquivo);

      const status = await readStatus();
      const esperado = cabeca.metadata['skygp-sha256']
        || (status.lastSuccess?.key === alvo ? status.lastSuccess.sha256 : null);
      if (!esperado) throw new BackupError('The object carries no recorded sha256 to compare against', 'no_checksum');
      if (esperado !== baixado.sha256) {
        throw new BackupError('The sha256 of the downloaded file does not match the one recorded at upload', 'checksum_mismatch');
      }
      if (listado && listado.size !== baixado.bytes) {
        throw new BackupError('The downloaded size does not match the listed size', 'size_mismatch');
      }
      const fh = await fs.promises.open(arquivo, 'r');
      const cabecalho = Buffer.alloc(HEADER_BYTES);
      try {
        await fh.read(cabecalho, 0, HEADER_BYTES, 0);
      } finally {
        await fh.close();
      }
      const forma = inspectEncrypted(cabecalho, baixado.bytes);
      parseHeader(cabecalho);
      const keyMatches = forma.keyId === config.keyId;
      const resultado = {
        status: keyMatches ? 'ok' : 'warning',
        trigger,
        at: new Date().toISOString(),
        durationMs: Date.now() - inicio,
        key: alvo,
        bytes: baixado.bytes,
        sha256: baixado.sha256,
        keyId: forma.keyId,
        keyMatches,
        chunks: forma.chunks,
        error: keyMatches ? null : 'This backup was encrypted for a different public key than the one configured now',
        code: keyMatches ? null : 'key_mismatch'
      };
      await writeStatus({ lastVerification: resultado });
      return resultado;
    } catch (error) {
      const mensagem = redact(error?.message || 'unknown error', config);
      const resultado = {
        status: 'failed',
        trigger,
        at: new Date().toISOString(),
        durationMs: Date.now() - inicio,
        key: alvo,
        error: mensagem,
        code: error?.code || 'verify_failed'
      };
      await writeStatus({ lastVerification: resultado }).catch(() => {});
      log.warn('external backup verification failed', { code: resultado.code, error: mensagem });
      await this.alertFailure({ stage: 'verify', source: 'panel', error: mensagem, now });
      return resultado;
    } finally {
      if (trabalho) fs.rmSync(trabalho, { recursive: true, force: true });
      await releaseLease(LEASE).catch(() => {});
    }
  }

  /**
   * O botão "testar conexão": o bucket responde (`HeadBucket`), aceita um
   * objeto pequeno e deixa apagá-lo. As três coisas que o backup de verdade
   * vai precisar, com um arquivo de 40 bytes em vez de um dump.
   */
  static async testConnection() {
    const config = await effectiveConfig();
    if (!config.connectionReady) {
      throw new BackupError('The S3 connection is not configured', 'not_configured');
    }
    const passos = { headBucket: false, put: false, delete: false };
    try {
      const cliente = this.client(config);
      await cliente.headBucket();
      passos.headBucket = true;
      const chave = `${config.connection.prefix}.skygp-connection-test-${crypto.randomBytes(6).toString('hex')}`;
      await cliente.putObject(chave, { body: Buffer.from('skygenpanel external backup connection test\n') });
      passos.put = true;
      await cliente.deleteObject(chave);
      passos.delete = true;
      return { ok: true, steps: passos };
    } catch (error) {
      return { ok: false, steps: passos, error: redact(error?.message, config), code: error?.code || 's3_error' };
    }
  }

  /** "Fazer backup agora": começa em segundo plano. */
  static async runNow({ now = new Date() } = {}) {
    const config = await effectiveConfig();
    if (!config.configured) throw new BackupError('The external backup is not configured', 'not_configured');
    if (!this.start(() => this.perform({ trigger: 'manual', now }))) {
      throw new BackupError('A backup or verification is already running', 'busy');
    }
    return { started: true };
  }

  /** "Verificar agora": também em segundo plano. */
  static async verifyNow({ now = new Date() } = {}) {
    const config = await effectiveConfig();
    if (!config.configured) throw new BackupError('The external backup is not configured', 'not_configured');
    if (!this.start(() => this.verifyLatest({ trigger: 'manual', now }))) {
      throw new BackupError('A backup or verification is already running', 'busy');
    }
    return { started: true };
  }

  /**
   * O passo do agendador, acima dos provedores. No máximo uma consulta por
   * minuto; o backup do dia à hora escolhida (Brasília) quando quem roda é o
   * painel, e a verificação semanal em qualquer caso. Não espera a passada
   * terminar — um dump grande não pode segurar o tick dos outros jobs.
   * Nunca lança.
   */
  static async schedulerPass({ now = new Date(), force = false } = {}) {
    try {
      if (this.current) return { skipped: 'running' };
      if (!force && now.getTime() - this.lastPassAt < PASS_INTERVAL_MS) return { skipped: 'interval' };
      this.lastPassAt = now.getTime();
      const config = await effectiveConfig();
      if (!config.configured || !config.enabled) return { skipped: 'disabled' };
      const status = await readStatus();
      const relogio = saoPauloClock(now);
      if (config.runner === 'panel' && relogio.hour >= config.hour && status.lastAttemptDay !== relogio.day) {
        this.start(() => this.perform({ trigger: 'schedule', now }));
        return { started: 'backup' };
      }
      const ultima = Date.parse(status.lastVerification?.at ?? '') || 0;
      if (status.lastSuccess && now.getTime() - ultima >= VERIFY_EVERY_MS) {
        this.start(() => this.verifyLatest({ trigger: 'schedule', now }));
        return { started: 'verify' };
      }
      return { skipped: 'nothing_due' };
    } catch (error) {
      log.warn('external backup scheduler pass failed', { err: { message: error?.message } });
      return { skipped: 'error' };
    }
  }

  /**
   * O aviso do host: o `OnFailure=` do systemd chama
   * `skygenpanel-backup notify-failure`, que chega aqui. Grava a falha no
   * estado (a tela mostra) e enfileira o `backup_failed`. Nunca lança.
   */
  static async recordHostFailure({ reason = 'skygenpanel-backup.service failed', now = new Date() } = {}) {
    const hostFailure = { at: now.toISOString(), reason: String(reason).slice(0, 300) };
    await writeStatus({ hostFailure }).catch(() => {});
    return this.alertFailure({ stage: 'backup', source: 'host', error: hostFailure.reason, now });
  }
}

export default ExternalBackupService;
