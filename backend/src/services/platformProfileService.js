import AppState from '../models/AppState.js';
import Tenant from '../models/Tenant.js';
import { runInTenant } from '../config/tenantContext.js';
import { isValidEmail } from '../utils/helpers.js';
import { normalizeTaxId, isValidCnpj } from '../utils/taxId.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';

/**
 * Os dados da empresa que vende o SaaS: o que a página pública mostra no
 * rodapé, o WhatsApp de contato e para onde vão os avisos de cadastro e de
 * lead.
 *
 * Mesmo molde de `billing/asaasSettingsService.js`: um blob em `app_state` na
 * caixa da plataforma, gravado pelo console, com o `.env` valendo para o campo
 * que o console nunca gravou. A diferença é que aqui nada é segredo — tudo
 * isto é publicado no site —, então não há cifra.
 */

export const CONFIG_KEY = 'platform_profile';

/** Campo → variável de ambiente que vale enquanto o console não gravou nada. */
const ENV_FALLBACK = Object.freeze({
  legalName: 'PLATFORM_LEGAL_NAME',
  tradeName: 'PLATFORM_TRADE_NAME',
  taxId: 'PLATFORM_TAX_ID',
  address: 'PLATFORM_ADDRESS',
  contactEmail: 'PLATFORM_CONTACT_EMAIL',
  contactWhatsapp: 'PLATFORM_CONTACT_WHATSAPP',
  notifyEmail: 'PLATFORM_NOTIFY_EMAIL',
  notifyWhatsapp: 'PLATFORM_NOTIFY_WHATSAPP',
  instagram: 'PLATFORM_INSTAGRAM',
  facebook: 'PLATFORM_FACEBOOK',
  youtube: 'PLATFORM_YOUTUBE',
  linkedin: 'PLATFORM_LINKEDIN'
});

export const PROFILE_FIELDS = Object.freeze(Object.keys(ENV_FALLBACK));

const MAX = { legalName: 160, tradeName: 80, taxId: 20, address: 240, contactEmail: 160, notifyEmail: 160 };
const URL_MAX = 300;
const SOCIAL = { instagram: 'instagram.com', facebook: 'facebook.com', youtube: 'youtube.com', linkedin: 'linkedin.com' };

const CACHE_TTL_MS = 15_000;
let cache = null;

export function invalidatePlatformProfile() {
  cache = null;
}

export class PlatformProfileError extends Error {
  constructor(message, { field = null, status = 400 } = {}) {
    super(message);
    this.name = 'PlatformProfileError';
    this.field = field;
    this.status = status;
  }
}

async function lerGuardado() {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const caixa = await Tenant.platform();
  let stored = {};
  if (caixa) {
    const bruto = await runInTenant(caixa.id, () => AppState.get(CONFIG_KEY));
    if (bruto) {
      try {
        const lido = JSON.parse(bruto);
        stored = lido && typeof lido === 'object' ? lido : {};
      } catch {
        stored = {};
      }
    }
  }
  const value = { platformId: caixa?.id ?? null, stored };
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return value;
}

function envValue(nome) {
  const valor = String(process.env[nome] ?? '').trim();
  return valor || null;
}

/** Os valores que valem, e de onde vem cada um (`db`, `env` ou `null`). */
export async function readProfile() {
  const { platformId, stored } = await lerGuardado();
  const values = {};
  const sources = {};
  for (const campo of PROFILE_FIELDS) {
    const doBanco = typeof stored[campo] === 'string' && stored[campo].trim() ? stored[campo] : null;
    const doAmbiente = doBanco ? null : envValue(ENV_FALLBACK[campo]);
    values[campo] = doBanco ?? doAmbiente;
    sources[campo] = doBanco ? 'db' : doAmbiente ? 'env' : null;
  }
  // O telefone do ambiente vem como foi digitado; a tela e o link querem dígitos.
  for (const campo of ['contactWhatsapp', 'notifyWhatsapp']) {
    if (values[campo]) values[campo] = String(values[campo]).replace(/\D/g, '') || null;
  }
  return { values, sources, canSave: Boolean(platformId), updatedAt: stored.updatedAt ?? null };
}

/** Um link de rede social: URL https do site da rede, ou `@usuario`. */
function socialUrl(campo, bruto) {
  const texto = String(bruto).trim();
  const host = SOCIAL[campo];
  if (texto.startsWith('@')) {
    const usuario = texto.slice(1);
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(usuario)) return null;
    return campo === 'youtube' ? `https://www.youtube.com/@${usuario}` : `https://www.${host}/${usuario}`;
  }
  try {
    const url = new URL(texto.includes('://') ? texto : `https://${texto}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const dominio = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    const aceitos = campo === 'youtube' ? ['youtube.com', 'youtu.be'] : [host];
    if (campo === 'facebook') aceitos.push('fb.com');
    if (!aceitos.includes(dominio)) return null;
    url.protocol = 'https:';
    return url.toString().slice(0, URL_MAX);
  } catch {
    return null;
  }
}

/** Um campo recebido → valor a gravar, `''` para apagar; lança se inválido. */
function normalizar(campo, bruto) {
  if (bruto === null || bruto === undefined) return '';
  const texto = String(bruto).trim();
  if (!texto) return '';
  if (campo === 'contactEmail' || campo === 'notifyEmail') {
    if (!isValidEmail(texto) || texto.length > MAX[campo]) {
      throw new PlatformProfileError('Invalid email address', { field: campo });
    }
    return texto;
  }
  if (campo === 'contactWhatsapp' || campo === 'notifyWhatsapp') {
    const numero = normalizarTelefoneBr(texto);
    if (!numero) throw new PlatformProfileError('Invalid WhatsApp number', { field: campo });
    return numero;
  }
  if (campo === 'taxId') {
    const digitos = normalizeTaxId(texto);
    if (!isValidCnpj(digitos)) throw new PlatformProfileError('Invalid CNPJ', { field: campo });
    return digitos.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  }
  if (SOCIAL[campo]) {
    const url = socialUrl(campo, texto);
    if (!url) throw new PlatformProfileError(`Invalid ${campo} link`, { field: campo });
    return url;
  }
  return texto.slice(0, MAX[campo] ?? 160);
}

/**
 * Grava o que veio no `patch`. Ausente mantém; vazio apaga o gravado (e o
 * `.env`, se tiver o campo, volta a valer). Devolve os nomes que mudaram.
 */
export async function saveProfile(patch = {}) {
  const { platformId, stored } = await lerGuardado();
  if (!platformId) {
    throw new PlatformProfileError(
      'The platform box does not exist yet; create it first (scripts/create-platform-tenant.js)',
      { status: 409 }
    );
  }
  const novo = { ...stored };
  const mudou = [];
  for (const campo of PROFILE_FIELDS) {
    if (!(campo in patch)) continue;
    const valor = normalizar(campo, patch[campo]);
    const antes = typeof stored[campo] === 'string' ? stored[campo] : '';
    if (valor === antes) continue;
    if (valor) novo[campo] = valor;
    else delete novo[campo];
    mudou.push(campo);
  }
  if (mudou.length) {
    novo.updatedAt = new Date().toISOString();
    await runInTenant(platformId, () => AppState.upsert(CONFIG_KEY, JSON.stringify(novo)));
    invalidatePlatformProfile();
  }
  return mudou;
}

export default { readProfile, saveProfile, invalidatePlatformProfile, PROFILE_FIELDS };
