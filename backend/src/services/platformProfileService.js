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

/**
 * A política de cobrança da plataforma que mora aqui também (0102): números,
 * e não texto, então fora de `PROFILE_FIELDS` — sem `.env`, com padrão
 * próprio, e voltam ao padrão quando o console os apaga (`null`).
 *
 *   autoSuspendDays      dias depois do vencimento em que o provedor que não
 *                        pagou é suspenso sozinho. Zero desliga.
 *   autoSuspendWarnDays  quantos dias antes da suspensão sai o aviso. Zero
 *                        desliga só o aviso; menor que `autoSuspendDays`.
 *   referralRewardCents  o crédito, em centavos, que quem indicou ganha
 *                        quando o indicado paga o primeiro período (0105).
 *                        Zero desliga o programa de indicação.
 */
export const BILLING_POLICY_FIELDS = Object.freeze({
  autoSuspendDays: { default: 15, min: 0, max: 90 },
  autoSuspendWarnDays: { default: 3, min: 0, max: 30 },
  referralRewardCents: { default: 0, min: 0, max: 1_000_000 },
  // A retenção no cancelamento (0106): o desconto oferecido a quem pede para
  // cancelar (porcentagem e por quantas faturas) e o máximo de meses de
  // pausa. Zero desliga a oferta correspondente.
  retentionDiscountPercent: { default: 20, min: 0, max: 90 },
  retentionDiscountMonths: { default: 3, min: 0, max: 24 },
  retentionPauseMaxMonths: { default: 2, min: 0, max: 12 }
});

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
  return {
    values,
    sources,
    billing: politicaDe(stored),
    billingDefaults: Object.fromEntries(Object.entries(BILLING_POLICY_FIELDS).map(([c, r]) => [c, r.default])),
    canSave: Boolean(platformId),
    updatedAt: stored.updatedAt ?? null
  };
}

/** Os números da política como valem: o gravado, ou o padrão. */
function politicaDe(stored) {
  const politica = {};
  for (const [campo, regra] of Object.entries(BILLING_POLICY_FIELDS)) {
    const gravado = stored?.[campo];
    politica[campo] = Number.isInteger(gravado) && gravado >= regra.min && gravado <= regra.max
      ? gravado
      : regra.default;
  }
  return politica;
}

/**
 * A suspensão automática como o agendador a lê: `{ days, warnDays }`. Nunca
 * lança — sem caixa da plataforma, ou com o banco fora, vale o padrão.
 */
export async function autoSuspendConfig() {
  const { stored } = await lerGuardado().catch(() => ({ stored: {} }));
  const politica = politicaDe(stored);
  return { days: politica.autoSuspendDays, warnDays: politica.autoSuspendWarnDays };
}

/**
 * O crédito da indicação como o pagamento o lê (0105): centavos, zero quando
 * desligado. Nunca lança — sem caixa da plataforma, ou com o banco fora, vale
 * o padrão (desligado). Sem o cache de quinze segundos: é dinheiro, e o
 * console que acabou de mudar o valor espera que o próximo pagamento o use.
 */
export async function referralRewardCents() {
  invalidatePlatformProfile();
  const { stored } = await lerGuardado().catch(() => ({ stored: {} }));
  return politicaDe(stored).referralRewardCents;
}

/**
 * As ofertas de retenção como o fluxo de cancelamento as lê:
 * `{ discountPercent, discountMonths, pauseMaxMonths }`. Nunca lança — sem
 * caixa da plataforma, ou com o banco fora, vale o padrão.
 */
export async function retentionConfig() {
  const { stored } = await lerGuardado().catch(() => ({ stored: {} }));
  const politica = politicaDe(stored);
  return {
    discountPercent: politica.retentionDiscountPercent,
    discountMonths: politica.retentionDiscountMonths,
    pauseMaxMonths: politica.retentionPauseMaxMonths
  };
}

/** Um número da política recebido → inteiro a gravar, `null` para o padrão; lança se inválido. */
function normalizarPolitica(campo, bruto) {
  if (bruto === null || bruto === undefined || bruto === '') return null;
  const regra = BILLING_POLICY_FIELDS[campo];
  const numero = typeof bruto === 'number' ? bruto : Number(String(bruto).trim());
  if (!Number.isInteger(numero) || numero < regra.min || numero > regra.max) {
    throw new PlatformProfileError(`${campo} must be an integer from ${regra.min} to ${regra.max}`, { field: campo });
  }
  return numero;
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
  for (const campo of Object.keys(BILLING_POLICY_FIELDS)) {
    if (!(campo in patch)) continue;
    const valor = normalizarPolitica(campo, patch[campo]);
    const antes = Number.isInteger(stored[campo]) ? stored[campo] : null;
    if (valor === antes) continue;
    if (valor === null) delete novo[campo];
    else novo[campo] = valor;
    mudou.push(campo);
  }
  // O aviso tem de cair ANTES da suspensão: com ele igual ou maior, sairia no
  // vencimento (ou antes dele) dizendo "vai ser suspenso" a quem nem atrasou.
  const politica = politicaDe(novo);
  if (politica.autoSuspendDays > 0 && politica.autoSuspendWarnDays >= politica.autoSuspendDays) {
    throw new PlatformProfileError('autoSuspendWarnDays must be smaller than autoSuspendDays', { field: 'autoSuspendWarnDays' });
  }
  if (mudou.length) {
    novo.updatedAt = new Date().toISOString();
    await runInTenant(platformId, () => AppState.upsert(CONFIG_KEY, JSON.stringify(novo)));
    invalidatePlatformProfile();
  }
  return mudou;
}

export default {
  readProfile, saveProfile, invalidatePlatformProfile, autoSuspendConfig, referralRewardCents, retentionConfig, PROFILE_FIELDS, BILLING_POLICY_FIELDS
};
