import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import { createDecryptStream } from './backupCrypto.js';
import { extractTar } from './tarArchive.js';

/**
 * O teste de restauração: decifrar, desempacotar e abrir o banco num lugar
 * TEMPORÁRIO, nunca no de produção.
 *
 * É o que a verificação semanal do servidor não consegue fazer — ela não tem a
 * chave privada. Roda na mão de quem tem a chave
 * (`skygenpanel-backup restore --from-s3 … --private-key …`) e no teste
 * automatizado da suíte, com um par gerado na hora.
 *
 * O que ele prova, nesta ordem:
 *
 * 1. todas as tags GCM fecham (o arquivo decifra até o fim, sem truncamento);
 * 2. o tar abre e traz um `manifest.json`;
 * 3. cada arquivo listado no manifesto tem o sha256 que o manifesto diz;
 * 4. o banco restaura num destino temporário — o arquivo SQLite aberto numa
 *    pasta temporária; no Postgres e no MySQL, um banco `skygp_restore_*`
 *    criado para isso e apagado no fim — e o ledger (`schema_migrations`)
 *    termina na migração que o manifesto registrou, com tabelas de verdade.
 */

export class RestoreError extends Error {
  constructor(message, code = 'restore_failed') {
    super(message);
    this.name = 'RestoreError';
    this.code = code;
  }
}

async function sha256Arquivo(arquivo) {
  const hash = crypto.createHash('sha256');
  for await (const p of fs.createReadStream(arquivo)) hash.update(p);
  return hash.digest('hex');
}

/** Decifra `encryptedFile` e extrai o tar em `destino`. Devolve o diretório do backup. */
export async function decryptAndExtract({ encryptedFile, privateKey, destino }) {
  async function* decifrado() {
    const dec = createDecryptStream(privateKey);
    const origem = fs.createReadStream(encryptedFile);
    origem.on('error', (e) => dec.destroy(e));
    origem.pipe(dec);
    for await (const pedaco of dec) yield pedaco;
  }
  const arquivos = await extractTar(Readable.from(decifrado()), destino);
  const manifestos = arquivos.filter((a) => a.split(path.sep).length === 2 && a.endsWith(`${path.sep}manifest.json`));
  if (manifestos.length !== 1) throw new RestoreError('The archive does not hold exactly one backup with a manifest.json', 'no_manifest');
  return path.join(destino, path.dirname(manifestos[0]));
}

/** Confere cada arquivo do manifesto pelo sha256. */
export async function verifyManifest(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const conferidos = [];
  for (const [nome, info] of Object.entries(manifest.files ?? {})) {
    const arquivo = path.join(dir, nome);
    if (!fs.existsSync(arquivo)) throw new RestoreError(`${nome} is listed in the manifest but missing`, 'missing_file');
    // eslint-disable-next-line no-await-in-loop -- poucos arquivos
    const sha = await sha256Arquivo(arquivo);
    if (sha !== info.sha256) throw new RestoreError(`${nome} does not match the sha256 in the manifest`, 'checksum_mismatch');
    conferidos.push(nome);
  }
  return { manifest, files: conferidos };
}

function checarSqlite(arquivo) {
  const db = new Database(arquivo, { fileMustExist: true });
  try {
    const [linha] = db.pragma('integrity_check');
    if (linha?.integrity_check !== 'ok') throw new RestoreError(`integrity_check said "${linha?.integrity_check}"`, 'corrupt_database');
    const tabelas = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get().n;
    const topo = db.prepare('SELECT id FROM schema_migrations ORDER BY id DESC LIMIT 1').get();
    return { tables: Number(tabelas), schemaMigration: topo?.id ?? null };
  } finally {
    db.close();
  }
}

function rodar(comando, args, { env = {}, stdinFile = null } = {}) {
  return new Promise((resolve, reject) => {
    let erro = '';
    const filho = spawn(comando, args, { env: { ...process.env, ...env }, stdio: [stdinFile ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    if (stdinFile) fs.createReadStream(stdinFile).pipe(filho.stdin);
    filho.stderr.on('data', (d) => {
      if (erro.length < 2000) erro += d.toString();
    });
    filho.on('error', (e) => reject(e.code === 'ENOENT' ? new RestoreError(`${comando} is not installed`, 'tool_missing') : e));
    filho.on('close', (code) => (code === 0 ? resolve() : reject(new RestoreError(`${comando} exited with ${code}: ${erro.trim().slice(-300)}`))));
  });
}

/**
 * Postgres: um banco temporário criado na mesma instância (`target`, que vem
 * de `DATABASE_URL`/db-config — o usuário precisa de CREATEDB), o
 * `pg_restore` nele, a conferência e o `DROP DATABASE` no fim.
 */
async function checarPostgres(arquivo, target, { keep = false } = {}) {
  const { default: pg } = await import('pg');
  const nome = `skygp_restore_${crypto.randomBytes(4).toString('hex')}`;
  const base = {
    host: target.host, port: target.port, user: target.user, password: target.password,
    ssl: target.ssl ? { rejectUnauthorized: target.sslRejectUnauthorized !== false } : undefined
  };
  const admin = new pg.Client({ ...base, database: target.adminDatabase || target.database || 'postgres' });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${nome}`);
    try {
      await rodar(process.env.SKYGP_PG_RESTORE || 'pg_restore', [
        '--no-owner', '--no-privileges', '--exit-on-error', `--host=${target.host}`, `--port=${target.port}`,
        `--username=${target.user}`, `--dbname=${nome}`, arquivo
      ], { env: { PGPASSWORD: target.password ?? '' } });
      const cliente = new pg.Client({ ...base, database: nome });
      await cliente.connect();
      try {
        const t = await cliente.query(
          "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog','information_schema')"
        );
        const s = await cliente.query("SELECT table_schema FROM information_schema.tables WHERE table_name = 'schema_migrations' LIMIT 1");
        const esquema = s.rows[0]?.table_schema;
        if (!esquema) throw new RestoreError('The restored database has no schema_migrations table', 'no_ledger');
        const topo = await cliente.query(`SELECT id FROM "${esquema.replace(/"/g, '""')}".schema_migrations ORDER BY id DESC LIMIT 1`);
        return { tables: t.rows[0].n, schemaMigration: topo.rows[0]?.id ?? null, database: nome };
      } finally {
        await cliente.end();
      }
    } finally {
      if (!keep) await admin.query(`DROP DATABASE IF EXISTS ${nome}`).catch(() => {});
    }
  } finally {
    await admin.end();
  }
}

/** MySQL: o mesmo, com `CREATE DATABASE`, o cliente `mysql` e `DROP DATABASE`. */
async function checarMysql(arquivo, target, { keep = false } = {}) {
  const { default: mysql } = await import('mysql2/promise');
  const nome = `skygp_restore_${crypto.randomBytes(4).toString('hex')}`;
  const conexao = await mysql.createConnection({ host: target.host, port: target.port, user: target.user, password: target.password });
  const cred = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-rst-')), 'my.cnf');
  fs.writeFileSync(cred, `[client]\npassword=${String(target.password ?? '').replace(/\n/g, '')}\n`, { mode: 0o600 });
  try {
    await conexao.query(`CREATE DATABASE \`${nome}\``);
    try {
      await rodar(process.env.SKYGP_MYSQL || 'mysql', [
        `--defaults-extra-file=${cred}`, `--host=${target.host}`, `--port=${target.port}`, `--user=${target.user}`, nome
      ], { stdinFile: arquivo });
      const [[t]] = await conexao.query(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE'", [nome]
      );
      const [[topo]] = await conexao.query(`SELECT id FROM \`${nome}\`.schema_migrations ORDER BY id DESC LIMIT 1`);
      return { tables: Number(t.n), schemaMigration: topo?.id ?? null, database: nome };
    } finally {
      if (!keep) await conexao.query(`DROP DATABASE IF EXISTS \`${nome}\``).catch(() => {});
    }
  } finally {
    await conexao.end();
    fs.rmSync(path.dirname(cred), { recursive: true, force: true });
  }
}

/**
 * Restaura o banco do backup em `dir` num destino temporário e confere.
 *
 * @param {string} dir o diretório extraído (com `manifest.json`)
 * @param {object} [opts]
 * @param {object} [opts.target] conexão para o Postgres/MySQL temporário
 * @param {boolean} [opts.keep] não apaga o banco temporário (para olhar)
 */
export async function restoreCheck(dir, { target = null, keep = false } = {}) {
  const { manifest, files } = await verifyManifest(dir);
  let banco;
  if (manifest.client === 'better-sqlite3' || fs.existsSync(path.join(dir, 'panel.sqlite'))) {
    banco = checarSqlite(path.join(dir, 'panel.sqlite'));
  } else if (manifest.client === 'pg') {
    if (!target) throw new RestoreError('A Postgres restore check needs a target connection', 'no_target');
    banco = await checarPostgres(path.join(dir, 'database.dump'), target, { keep });
  } else if (manifest.client === 'mysql2') {
    if (!target) throw new RestoreError('A MySQL restore check needs a target connection', 'no_target');
    banco = await checarMysql(path.join(dir, 'database.sql'), target, { keep });
  } else {
    throw new RestoreError(`Unknown database client in the manifest: ${manifest.client}`, 'unknown_client');
  }
  if (!banco.tables) throw new RestoreError('The restored database has no tables', 'empty_database');
  const esperado = manifest.schemaMigration;
  const conhecido = esperado && !['unknown', 'none'].includes(esperado);
  if (conhecido && banco.schemaMigration !== esperado) {
    throw new RestoreError(
      `The restored ledger ends at ${banco.schemaMigration}, but the manifest recorded ${esperado}`, 'ledger_mismatch'
    );
  }
  return {
    ok: true,
    client: manifest.client,
    takenAt: manifest.takenAt ?? null,
    panelVersion: manifest.panelVersion ?? null,
    schemaMigration: banco.schemaMigration,
    expectedMigration: esperado ?? null,
    tables: banco.tables,
    files,
    secretFingerprints: manifest.secretFingerprints ?? null,
    ...(banco.database ? { database: banco.database, kept: keep } : {})
  };
}
