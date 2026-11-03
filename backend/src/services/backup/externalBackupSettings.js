import AppState from '../../models/AppState.js';
import Tenant from '../../models/Tenant.js';
import { runInTenant } from '../../config/tenantContext.js';
import { createSecretBox } from '../../utils/secretBox.js';
import { BackupCryptoError, parsePublicKey } from './backupCrypto.js';

/**
 * A configuração do backup externo, gravada pelo console.
 *
 * Mora no `app_state` da caixa da plataforma, no molde de
 * `asaasSettingsService`: é um segredo da PLATAFORMA, e não de um provedor.
 * Sem caixa (a instalação própria que nunca criou uma) gravar é recusado com o
 * motivo — a CLI do host lê daqui também, então o operador configura uma vez,
 * no console, e o timer do systemd usa a mesma conta.
 *
 * ## O que vai cifrado, e o que não
 *
 * Endpoint, região, bucket, prefixo, access key e secret vão juntos num
 * envelope só (`connection`), cifrado pela caixa de segredos — o contexto está
 * em `secretRotationService.BLOBS`. Juntos porque têm o mesmo raio de estrago:
 * quem tem um tem o caminho para os outros, e o endereço do bucket também é
 * informação que não precisa ficar legível num dump do banco.
 *
 * A chave PÚBLICA vai em claro: é pública, e é o que qualquer um que leia o
 * banco poderia ter sem perigo nenhum — ela só cifra. A privada nunca passa
 * por aqui.
 *
 * O estado (último envio, última verificação, falha do host) mora numa chave à
 * parte (`STATUS_KEY`), para quem grava o estado não reescrever a configuração.
 */

export const CONFIG_KEY = 'external_backup_config';
export const STATUS_KEY = 'external_backup_status';
export const SECRET_CONTEXT = 'skygenpanel-external-backup-v1';
export const RUNNERS = Object.freeze(['panel', 'host']);

export const DEFAULTS = Object.freeze({
  enabled: false,
  runner: 'panel',
  hour: 3,
  keepDaily: 7,
  keepWeekly: 4,
  includeMedia: true
});

const LIMITES = Object.freeze({
  endpoint: 255, region: 64, bucket: 63, prefix: 200, accessKeyId: 128, secretAccessKey: 256
});

export class BackupSettingsError extends Error {
  constructor(message, { code = 'invalid', status = 400, field = null } = {}) {
    super(message);
    this.name = 'BackupSettingsError';
    this.code = code;
    this.status = status;
    this.field = field;
  }
}

let caixa = null;
function box() {
  if (!caixa) caixa = createSecretBox(SECRET_CONTEXT);
  return caixa;
}

const selar = (texto) => ({ v: 1, ...box().encrypt(texto) });

function abrirConexao(envelope) {
  if (!envelope || typeof envelope !== 'object') return { conexao: null, legivel: true };
  const aberto = box().decrypt(envelope);
  if (!aberto) return { conexao: null, legivel: false };
  try {
    const lido = JSON.parse(String(aberto));
    return { conexao: lido && typeof lido === 'object' ? lido : null, legivel: true };
  } catch {
    return { conexao: null, legivel: false };
  }
}

async function caixaDaPlataforma() {
  const tenant = await Tenant.platform();
  return tenant?.id ?? null;
}

function parseJson(bruto) {
  if (!bruto) return null;
  try {
    const lido = JSON.parse(bruto);
    return lido && typeof lido === 'object' ? lido : null;
  } catch {
    return null;
  }
}

async function lerChave(platformId, chave) {
  return parseJson(await runInTenant(platformId, () => AppState.get(chave)));
}

/** O que está gravado, cru (com o envelope ainda fechado). */
async function lerGuardado() {
  const platformId = await caixaDaPlataforma();
  const stored = platformId ? await lerChave(platformId, CONFIG_KEY) : null;
  return { platformId, stored };
}

function inteiro(valor, { min, max, padrao }) {
  return Number.isInteger(valor) && valor >= min && valor <= max ? valor : padrao;
}

function ajustes(stored) {
  const s = stored ?? {};
  return {
    enabled: s.enabled === true,
    runner: RUNNERS.includes(s.runner) ? s.runner : DEFAULTS.runner,
    hour: inteiro(s.hour, { min: 0, max: 23, padrao: DEFAULTS.hour }),
    keepDaily: inteiro(s.keepDaily, { min: 1, max: 365, padrao: DEFAULTS.keepDaily }),
    keepWeekly: inteiro(s.keepWeekly, { min: 0, max: 520, padrao: DEFAULTS.keepWeekly }),
    includeMedia: s.includeMedia !== false
  };
}

/**
 * Tudo, com os segredos abertos — só para quem vai falar com o bucket.
 * Nunca vai para resposta nem para log.
 */
export async function effectiveConfig() {
  const { platformId, stored } = await lerGuardado();
  const { conexao, legivel } = abrirConexao(stored?.connection);
  const connection = conexao ? {
    endpoint: conexao.endpoint || '',
    region: conexao.region || 'us-east-1',
    bucket: conexao.bucket || '',
    prefix: conexao.prefix || '',
    forcePathStyle: conexao.forcePathStyle === true,
    accessKeyId: conexao.accessKeyId || '',
    secretAccessKey: conexao.secretAccessKey || ''
  } : null;
  const connectionReady = Boolean(connection?.bucket && connection.accessKeyId && connection.secretAccessKey);
  return {
    platformId,
    ...ajustes(stored),
    connection,
    connectionReadable: legivel,
    connectionReady,
    publicKey: typeof stored?.publicKey === 'string' ? stored.publicKey : null,
    keyId: typeof stored?.keyId === 'string' ? stored.keyId : null,
    keyCreatedAt: stored?.keyCreatedAt ?? null,
    keyOrigin: stored?.keyOrigin ?? null,
    configured: connectionReady && typeof stored?.publicKey === 'string',
    updatedAt: stored?.updatedAt ?? null
  };
}

/** Os quatro últimos caracteres, e só eles: o bastante para reconhecer qual chave é. */
export function maskTail(valor) {
  const texto = String(valor ?? '');
  if (!texto) return null;
  return texto.length <= 4 ? '••••' : `••••${texto.slice(-4)}`;
}

/** O que a tela pode ver. Nenhum segredo: a secret nunca, a access key mascarada. */
export async function readPublic() {
  const efetivo = await effectiveConfig();
  const c = efetivo.connection;
  return {
    configured: efetivo.configured,
    platformBox: Boolean(efetivo.platformId),
    enabled: efetivo.enabled,
    runner: efetivo.runner,
    hour: efetivo.hour,
    keepDaily: efetivo.keepDaily,
    keepWeekly: efetivo.keepWeekly,
    includeMedia: efetivo.includeMedia,
    endpoint: c?.endpoint ?? '',
    region: c?.region ?? '',
    bucket: c?.bucket ?? '',
    prefix: c?.prefix ?? '',
    forcePathStyle: c?.forcePathStyle ?? false,
    accessKeyIdHint: maskTail(c?.accessKeyId),
    secretAccessKeyConfigured: Boolean(c?.secretAccessKey),
    connectionReadable: efetivo.connectionReadable,
    publicKey: efetivo.publicKey,
    keyId: efetivo.keyId,
    keyCreatedAt: efetivo.keyCreatedAt,
    keyOrigin: efetivo.keyOrigin,
    updatedAt: efetivo.updatedAt,
    status: await readStatus()
  };
}

function texto(valor, campo, { obrigatorioFormato = null } = {}) {
  if (valor === null) return '';
  if (typeof valor !== 'string') throw new BackupSettingsError(`${campo} must be a string`, { field: campo });
  const aparado = valor.trim();
  if (aparado.length > LIMITES[campo]) throw new BackupSettingsError(`${campo} is too long`, { field: campo });
  if (aparado && obrigatorioFormato && !obrigatorioFormato.test(aparado)) {
    throw new BackupSettingsError(`${campo} is invalid`, { field: campo });
  }
  return aparado;
}

function validarEndpoint(valor) {
  const t = texto(valor, 'endpoint');
  if (!t) return '';
  let url;
  try {
    url = new URL(t);
  } catch {
    throw new BackupSettingsError('endpoint must be a URL', { field: 'endpoint' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new BackupSettingsError('endpoint must be http or https', { field: 'endpoint' });
  }
  // Credencial na URL iria parar em log de proxy; query e fragmento não têm
  // lugar num endpoint de S3.
  if (url.username || url.password || url.search || url.hash) {
    throw new BackupSettingsError('endpoint must not carry credentials, query or fragment', { field: 'endpoint' });
  }
  return t.replace(/\/+$/, '');
}

/**
 * Grava. Campo ausente não é tocado; a secret vazia ou nula apaga. A access
 * key e a secret nunca voltam para a tela, então um formulário que reenvia
 * tudo manda as duas ausentes — e elas ficam.
 */
export async function save(patch = {}) {
  const { platformId, stored } = await lerGuardado();
  if (!platformId) {
    throw new BackupSettingsError('There is no platform box in this deployment to store the backup settings in', {
      code: 'no_platform_tenant', status: 409
    });
  }
  const anterior = stored ?? {};
  const { conexao: conexaoAnterior, legivel } = abrirConexao(anterior.connection);
  const conexao = { ...(conexaoAnterior ?? {}) };
  let conexaoMudou = false;
  const mudou = {};

  const campos = {
    endpoint: () => validarEndpoint(patch.endpoint),
    region: () => texto(patch.region, 'region', { obrigatorioFormato: /^[a-z0-9-]+$/ }),
    bucket: () => texto(patch.bucket, 'bucket', { obrigatorioFormato: /^[A-Za-z0-9][A-Za-z0-9._-]{1,61}[A-Za-z0-9]$/ }),
    prefix: () => {
      const p = texto(patch.prefix, 'prefix', { obrigatorioFormato: /^[A-Za-z0-9!_.*'()/-]+$/ });
      if (p.startsWith('/') || p.includes('..')) throw new BackupSettingsError('prefix is invalid', { field: 'prefix' });
      return p && !p.endsWith('/') ? `${p}/` : p;
    },
    accessKeyId: () => texto(patch.accessKeyId, 'accessKeyId', { obrigatorioFormato: /^\S+$/ }),
    secretAccessKey: () => texto(patch.secretAccessKey, 'secretAccessKey', { obrigatorioFormato: /^\S+$/ })
  };
  for (const [campo, ler] of Object.entries(campos)) {
    if (patch[campo] === undefined) continue;
    const valor = ler();
    if (valor !== (conexao[campo] ?? '')) mudou[campo] = true;
    conexao[campo] = valor;
    conexaoMudou = true;
  }
  if (patch.forcePathStyle !== undefined) {
    if (typeof patch.forcePathStyle !== 'boolean') {
      throw new BackupSettingsError('forcePathStyle must be a boolean', { field: 'forcePathStyle' });
    }
    if (patch.forcePathStyle !== (conexao.forcePathStyle === true)) mudou.forcePathStyle = true;
    conexao.forcePathStyle = patch.forcePathStyle;
    conexaoMudou = true;
  }
  // Uma conexão que a chave atual não abre não é mesclada: reescrevê-la com só
  // os campos do patch apagaria o resto em silêncio.
  if (conexaoMudou && !legivel) {
    throw new BackupSettingsError(
      'The stored connection cannot be decrypted with this server key; send every connection field to replace it',
      { code: 'connection_unreadable', status: 409 }
    );
  }

  const proximo = { ...anterior, v: 1 };
  if (conexaoMudou) proximo.connection = selar(JSON.stringify(conexao));

  const atuais = ajustes(anterior);
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') throw new BackupSettingsError('enabled must be a boolean', { field: 'enabled' });
    proximo.enabled = patch.enabled;
    if (patch.enabled !== atuais.enabled) mudou.enabled = true;
  }
  if (patch.runner !== undefined) {
    if (!RUNNERS.includes(patch.runner)) {
      throw new BackupSettingsError(`runner must be one of ${RUNNERS.join(', ')}`, { field: 'runner' });
    }
    proximo.runner = patch.runner;
    if (patch.runner !== atuais.runner) mudou.runner = true;
  }
  const numeros = { hour: [0, 23], keepDaily: [1, 365], keepWeekly: [0, 520] };
  for (const [campo, [min, max]] of Object.entries(numeros)) {
    if (patch[campo] === undefined) continue;
    const n = patch[campo];
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new BackupSettingsError(`${campo} must be a whole number between ${min} and ${max}`, { field: campo });
    }
    proximo[campo] = n;
    if (n !== atuais[campo]) mudou[campo] = true;
  }
  if (patch.includeMedia !== undefined) {
    if (typeof patch.includeMedia !== 'boolean') {
      throw new BackupSettingsError('includeMedia must be a boolean', { field: 'includeMedia' });
    }
    proximo.includeMedia = patch.includeMedia;
    if (patch.includeMedia !== atuais.includeMedia) mudou.includeMedia = true;
  }
  if (patch.publicKey !== undefined) {
    const chave = definirChave(patch.publicKey, patch.keyOrigin);
    Object.assign(proximo, chave);
    if (chave.keyId !== anterior.keyId) mudou.publicKey = true;
  }
  proximo.updatedAt = new Date().toISOString();
  await runInTenant(platformId, () => AppState.upsert(CONFIG_KEY, JSON.stringify(proximo)));
  return { settings: await readPublic(), changed: mudou };
}

function definirChave(publicKey, origem) {
  if (publicKey === null || publicKey === '') {
    return { publicKey: null, keyId: null, keyCreatedAt: null, keyOrigin: null };
  }
  let lida;
  try {
    lida = parsePublicKey(publicKey);
  } catch (error) {
    if (error instanceof BackupCryptoError) {
      throw new BackupSettingsError(error.message, { code: 'invalid_public_key', field: 'publicKey' });
    }
    throw error;
  }
  return {
    publicKey: lida.text,
    keyId: lida.keyId,
    keyCreatedAt: new Date().toISOString(),
    keyOrigin: ['browser', 'server', 'imported'].includes(origem) ? origem : 'imported'
  };
}

/** O estado do último envio, da última verificação e da última falha do host. */
export async function readStatus() {
  const platformId = await caixaDaPlataforma();
  const lido = platformId ? await lerChave(platformId, STATUS_KEY) : null;
  return {
    lastRun: lido?.lastRun ?? null,
    lastSuccess: lido?.lastSuccess ?? null,
    lastVerification: lido?.lastVerification ?? null,
    hostFailure: lido?.hostFailure ?? null,
    lastAttemptDay: lido?.lastAttemptDay ?? null
  };
}

/** Mescla `patch` no estado. Sem caixa da plataforma, não há onde gravar: devolve falso. */
export async function writeStatus(patch) {
  const platformId = await caixaDaPlataforma();
  if (!platformId) return false;
  const atual = (await lerChave(platformId, STATUS_KEY)) ?? {};
  await runInTenant(platformId, () => AppState.upsert(STATUS_KEY, JSON.stringify({ ...atual, ...patch })));
  return true;
}

export default { effectiveConfig, readPublic, save, readStatus, writeStatus, maskTail };
