import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { readDbConfig, resolveClient } from '../../config/dbConfig.js';
import { DATA_DIR, SQLITE_PATH } from '../../config/paths.js';
import { getDb } from '../../config/database.js';
import { packDirectory } from './tarArchive.js';

/**
 * O mesmo backup que `deploy/skygenpanel-backup run` tira, feito de DENTRO do
 * processo do painel — para o Docker/SaaS, onde não há systemd nem timer.
 *
 * O layout é o do script, de propósito: um diretório com o dump do banco
 * (`database.dump` no Postgres, `database.sql` no MySQL, `panel.sqlite` no
 * SQLite), os anexos em `wa-media.tar.gz`, o `db-config.json` quando há, e o
 * `manifest.json` com a migração do topo, as impressões digitais das chaves e
 * o sha256 de cada arquivo. Um restore não precisa saber de onde o backup veio.
 */

const AQUI = path.dirname(fileURLToPath(import.meta.url));

export class BackupError extends Error {
  constructor(message, code = 'backup_failed') {
    super(message);
    this.name = 'BackupError';
    this.code = code;
  }
}

/** `2026-11-03T031700Z` — o mesmo carimbo do script. */
export function stampOf(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '');
}

async function sha256Arquivo(arquivo) {
  const hash = crypto.createHash('sha256');
  for await (const p of fs.createReadStream(arquivo)) hash.update(p);
  return hash.digest('hex');
}

/** A impressão digital de uma variável — a mesma conta do script (`env_fingerprint`). */
export function envFingerprint(nome, valor = process.env[nome]) {
  if (!valor) return 'absent';
  return crypto.createHash('sha256').update(`${nome}:${valor}`).digest('hex').slice(0, 12);
}

/** Roda um dump, com a senha por ambiente (nunca em argv) e a saída num arquivo. */
function rodar(comando, args, { env = {}, stdoutFile = null } = {}) {
  return new Promise((resolve, reject) => {
    let erro = '';
    const filho = spawn(comando, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', stdoutFile ? 'pipe' : 'ignore', 'pipe']
    });
    let escrita = Promise.resolve();
    if (stdoutFile) {
      const destino = fs.createWriteStream(stdoutFile, { mode: 0o600 });
      escrita = new Promise((ok, falha) => {
        destino.on('finish', ok);
        destino.on('error', falha);
      });
      filho.stdout.pipe(destino);
    }
    filho.stderr.on('data', (d) => {
      if (erro.length < 2000) erro += d.toString();
    });
    filho.on('error', (e) => {
      reject(e.code === 'ENOENT'
        ? new BackupError(`${comando} is not installed in this image or host`, 'dump_tool_missing')
        : e);
    });
    const saiu = new Promise((ok) => filho.on('close', ok));
    Promise.all([saiu, escrita]).then(([code]) => {
      if (code === 0) resolve();
      else {
        const resumo = erro.trim().split('\n').slice(-3).join(' ').slice(0, 300);
        reject(new BackupError(`${comando} exited with ${code}: ${resumo}`, 'dump_failed'));
      }
    }, reject);
  });
}

async function dumpPostgres(config, arquivo) {
  const args = ['--format=custom', '--no-owner', '--no-privileges',
    `--host=${config.host ?? '127.0.0.1'}`, `--port=${config.port ?? 5432}`,
    `--username=${config.user ?? ''}`, `--dbname=${config.database ?? ''}`, `--file=${arquivo}`];
  if (config.schema) args.push(`--schema=${config.schema}`);
  const sslmode = config.ssl ? (config.sslRejectUnauthorized === false ? 'require' : 'verify-full') : 'disable';
  await rodar(process.env.SKYGP_PG_DUMP || 'pg_dump', args, {
    env: { PGPASSWORD: config.password ?? '', PGSSLMODE: sslmode }
  });
}

async function dumpMysql(config, arquivo, tmp) {
  const cred = path.join(tmp, 'my.cnf');
  fs.writeFileSync(cred, `[client]\npassword=${String(config.password ?? '').replace(/\n/g, '')}\n`, { mode: 0o600 });
  try {
    await rodar(process.env.SKYGP_MYSQLDUMP || 'mysqldump', [
      `--defaults-extra-file=${cred}`, `--host=${config.host ?? '127.0.0.1'}`, `--port=${config.port ?? 3306}`,
      `--user=${config.user ?? ''}`, '--single-transaction', '--routines', '--events',
      '--default-character-set=utf8mb4', String(config.database ?? '')
    ], { stdoutFile: arquivo });
  } finally {
    fs.rmSync(cred, { force: true });
  }
}

async function dumpSqlite(config, arquivo) {
  const origem = config.filename || SQLITE_PATH;
  if (!fs.existsSync(origem)) throw new BackupError(`no SQLite database at ${origem}`, 'dump_failed');
  const db = new Database(origem, { readonly: true, fileMustExist: true });
  try {
    await db.backup(arquivo);
  } finally {
    db.close();
  }
  const copia = new Database(arquivo, { readonly: true, fileMustExist: true });
  try {
    const [linha] = copia.pragma('integrity_check');
    if (linha?.integrity_check !== 'ok') throw new BackupError(`integrity_check on the copy said "${linha?.integrity_check}"`, 'dump_failed');
    const n = copia.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!n?.n) throw new BackupError('the copy has no schema_migrations table', 'dump_failed');
  } finally {
    copia.close();
  }
}

function versaoDoPainel() {
  for (const candidato of [path.join(AQUI, '..', '..', '..', '..', 'package.json'), path.join(AQUI, '..', '..', '..', 'package.json')]) {
    try {
      const versao = JSON.parse(fs.readFileSync(candidato, 'utf8')).version;
      if (versao) return versao;
    } catch {
      // o próximo
    }
  }
  return 'unknown';
}

/** A migração do topo do ledger, ou `unknown`. */
export async function topMigration() {
  try {
    const linha = await getDb()('schema_migrations').orderBy('id', 'desc').first('id');
    return linha?.id ?? 'none';
  } catch {
    return 'unknown';
  }
}

/**
 * Tira o backup em `destino` (criado aqui, 0700). Devolve o manifesto.
 *
 * @param {object} opts
 * @param {string} opts.destino o diretório do backup — o nome é o carimbo
 * @param {boolean} [opts.includeMedia]
 */
export async function createLocalBackup({ destino, includeMedia = true, now = new Date() }) {
  const config = readDbConfig();
  const client = resolveClient(config);
  fs.mkdirSync(destino, { recursive: true, mode: 0o700 });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-dump-'));
  try {
    let arquivoBanco;
    if (client === 'pg') {
      arquivoBanco = path.join(destino, 'database.dump');
      await dumpPostgres(config, arquivoBanco);
    } else if (client === 'mysql2') {
      arquivoBanco = path.join(destino, 'database.sql');
      await dumpMysql(config, arquivoBanco, tmp);
    } else {
      arquivoBanco = path.join(destino, 'panel.sqlite');
      await dumpSqlite(config, arquivoBanco);
    }
    if (!fs.existsSync(arquivoBanco) || fs.statSync(arquivoBanco).size === 0) {
      throw new BackupError(`The database dump came out empty: ${path.basename(arquivoBanco)}`, 'dump_failed');
    }

    const arquivos = [arquivoBanco];
    const midia = path.join(DATA_DIR, 'wa-media');
    if (includeMedia && fs.existsSync(midia) && fs.statSync(midia).isDirectory()) {
      const alvo = path.join(destino, 'wa-media.tar.gz');
      await pipeline(packDirectory(midia, 'wa-media'), zlib.createGzip(), fs.createWriteStream(alvo, { mode: 0o600 }));
      arquivos.push(alvo);
    }
    const dbConfig = path.join(DATA_DIR, 'db-config.json');
    if (fs.existsSync(dbConfig)) {
      const alvo = path.join(destino, 'db-config.json');
      fs.copyFileSync(dbConfig, alvo);
      fs.chmodSync(alvo, 0o600);
      arquivos.push(alvo);
    }

    const files = {};
    for (const arquivo of arquivos) {
      // eslint-disable-next-line no-await-in-loop -- poucos arquivos
      files[path.basename(arquivo)] = { bytes: fs.statSync(arquivo).size, sha256: await sha256Arquivo(arquivo) };
    }
    const manifest = {
      takenAt: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      client,
      panelVersion: versaoDoPainel(),
      revision: 'unknown',
      schemaMigration: await topMigration(),
      includesEnv: false,
      source: 'panel',
      secretFingerprints: {
        SECRET_BOX_KEY: envFingerprint('SECRET_BOX_KEY'),
        JWT_SECRET: envFingerprint('JWT_SECRET')
      },
      files
    };
    fs.writeFileSync(path.join(destino, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    return manifest;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
