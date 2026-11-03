import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * O backup externo pela linha de comando do host — o que o
 * `deploy/skygenpanel-backup` chama depois do `run`, e o que se usa no dia do
 * restore.
 *
 *   node scripts/backup-external.js upload [diretório] [--if-configured]
 *   node scripts/backup-external.js notify-failure [--reason "texto"]
 *   node scripts/backup-external.js verify
 *   node scripts/backup-external.js list
 *   node scripts/backup-external.js status
 *   node scripts/backup-external.js restore --from-s3 <chave|latest> --private-key <arquivo> [--keep] [--target-url URL]
 *   node scripts/backup-external.js restore --file <arquivo.skygpbk> --private-key <arquivo> [--keep] [--target-url URL]
 *
 * A configuração (bucket, credenciais, chave pública, retenção) é a que o
 * console gravou no banco: o operador configura uma vez, em Integrações →
 * Backup externo, e o timer do host usa a mesma.
 *
 * O `restore` NUNCA toca o banco de produção: decifra numa pasta temporária,
 * confere o sha256 de cada arquivo contra o manifesto e abre o banco num
 * destino temporário (o arquivo SQLite; no Postgres/MySQL, um banco
 * `skygp_restore_*` criado e apagado no fim — o usuário precisa poder criar
 * banco, ou passe `--target-url` de um servidor de teste). A restauração de
 * verdade, para produção, é o passo manual de docs/saas-operations.md, feito
 * a partir da pasta que `--keep` deixa.
 */

function argumentos(argv) {
  const opcoes = {};
  const posicionais = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const proximo = argv[i + 1];
      if (proximo === undefined || proximo.startsWith('--')) opcoes[a.slice(2)] = true;
      else {
        opcoes[a.slice(2)] = proximo;
        i += 1;
      }
    } else posicionais.push(a);
  }
  return { opcoes, posicionais };
}

/**
 * Um caminho dado na linha de comando, relativo a onde a PESSOA estava: o
 * `skygenpanel-backup` entra em `backend/` antes de chamar este script e
 * passa o diretório de origem em `SKYGP_CALLER_CWD`.
 */
const caminho = (p) => path.resolve(process.env.SKYGP_CALLER_CWD || process.cwd(), p);

const saida = (objeto) => process.stdout.write(`${JSON.stringify(objeto, null, 2)}\n`);

/** O backup mais novo (com manifesto) sob o destino do script do host. */
function maisNovo(raiz) {
  if (!fs.existsSync(raiz)) return null;
  const nomes = fs.readdirSync(raiz, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(raiz, e.name, 'manifest.json')))
    .map((e) => e.name)
    .sort()
    .reverse();
  return nomes.length ? path.join(raiz, nomes[0]) : null;
}

async function restaurar(opcoes) {
  const { decryptAndExtract, restoreCheck } = await import('../src/services/backup/backupRestore.js');
  const { parsePrivateKey } = await import('../src/services/backup/backupCrypto.js');
  if (typeof opcoes['private-key'] !== 'string') throw new Error('restore needs --private-key <file>');
  const chave = parsePrivateKey(fs.readFileSync(caminho(opcoes['private-key']), 'utf8'));
  const trabalho = fs.mkdtempSync(path.join(process.env.SKYGP_BACKUP_TMP || os.tmpdir(), 'skygp-restore-'));
  fs.chmodSync(trabalho, 0o700);
  let manter = opcoes.keep === true;
  try {
    let arquivo = typeof opcoes.file === 'string' ? caminho(opcoes.file) : null;
    let origem = arquivo;
    if (!arquivo) {
      if (typeof opcoes['from-s3'] !== 'string') throw new Error('restore needs --from-s3 <key|latest> or --file <path>');
      const { default: Service } = await import('../src/services/backup/externalBackupService.js');
      const { effectiveConfig } = await import('../src/services/backup/externalBackupSettings.js');
      const config = await effectiveConfig();
      if (!config.connectionReady) throw new Error('The S3 connection is not configured in the console');
      let key = opcoes['from-s3'];
      if (key === 'latest') {
        const [ultimo] = await Service.listBackups(config);
        if (!ultimo) throw new Error('There is no backup in the bucket');
        key = ultimo.key;
      }
      arquivo = path.join(trabalho, 'download.skygpbk');
      await Service.client(config).getObjectToFile(key, arquivo);
      origem = key;
    }
    const dir = await decryptAndExtract({ encryptedFile: arquivo, privateKey: chave, destino: path.join(trabalho, 'extracted') });
    let target = null;
    if (typeof opcoes['target-url'] === 'string') {
      const { dbConfigFromEnv } = await import('../src/config/dbConfig.js');
      target = dbConfigFromEnv(opcoes['target-url']);
    } else {
      const { readDbConfig, resolveClient } = await import('../src/config/dbConfig.js');
      const atual = readDbConfig();
      if (resolveClient(atual) !== 'better-sqlite3') target = atual;
    }
    const resultado = await restoreCheck(dir, { target, keep: manter });
    saida({ ...resultado, source: origem, ...(manter ? { extractedTo: dir } : {}) });
  } catch (error) {
    manter = false;
    throw error;
  } finally {
    if (!manter) fs.rmSync(trabalho, { recursive: true, force: true });
  }
}

async function main() {
  const [verbo, ...resto] = process.argv.slice(2);
  const { opcoes, posicionais } = argumentos(resto);

  if (verbo === 'restore') return restaurar(opcoes);

  const { default: Service } = await import('../src/services/backup/externalBackupService.js');
  const { effectiveConfig, readStatus } = await import('../src/services/backup/externalBackupSettings.js');

  if (verbo === 'upload') {
    const config = await effectiveConfig();
    if (opcoes['if-configured']) {
      // Sair 0 em todos estes casos: o timer do host roda este passo todo dia,
      // e "não configurado" não é falha do backup local que acabou de dar certo.
      if (!config.configured) return saida({ status: 'skipped', reason: 'not_configured' });
      if (!config.enabled) return saida({ status: 'skipped', reason: 'disabled' });
      if (config.runner !== 'host') return saida({ status: 'skipped', reason: 'runner_is_panel' });
    }
    const dir = posicionais[0] || maisNovo(process.env.SKYGP_BACKUP_DIR || '/var/backups/skygenpanel');
    if (!dir) throw new Error('No finished backup to upload (run `skygenpanel-backup run` first)');
    const resultado = await Service.perform({ trigger: 'host', sourceDir: caminho(dir) });
    saida(resultado);
    if (resultado.status === 'failed' || (resultado.status === 'skipped' && resultado.reason === 'not_configured')) process.exitCode = 1;
    return undefined;
  }
  if (verbo === 'notify-failure') {
    const r = await Service.recordHostFailure({ reason: typeof opcoes.reason === 'string' ? opcoes.reason : undefined });
    return saida({ recorded: true, alert: r });
  }
  if (verbo === 'verify') {
    const r = await Service.verifyLatest({ trigger: 'host' });
    saida(r);
    if (r.status === 'failed') process.exitCode = 1;
    return undefined;
  }
  if (verbo === 'list') return saida(await Service.listBackups());
  if (verbo === 'status') return saida(await readStatus());
  process.stderr.write('usage: backup-external.js upload|notify-failure|verify|list|status|restore (see the header of this file)\n');
  process.exitCode = 1;
  return undefined;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`backup-external: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  // O pool só existe se alguém o abriu; fechá-lo deixa o processo sair.
  const { closePool } = await import('../src/config/database.js');
  await closePool().catch(() => {});
}
