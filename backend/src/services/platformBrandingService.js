import express from 'express';
import AppState from '../models/AppState.js';
import Tenant from '../models/Tenant.js';
import { runInTenant } from '../config/tenantContext.js';

/**
 * A logo e o favicon do sistema, enviados em Configurações → Dados do SaaS.
 *
 * Mesmo molde de `platformProfileService`: um blob em `app_state` na caixa da
 * plataforma. As imagens ficam em base64 dentro dele — são pequenas por
 * contrato (ver `LIMITS`), e assim não há disco, tabela nem rota estática
 * nova. SVG fica de fora de propósito: serve-se a imagem da mesma origem do
 * painel, e um SVG pode carregar script.
 */

export const BRANDING_KEY = 'platform_branding';
/** `icon` é o ícone da tela de início do celular (apple-touch-icon): 180×180 opaco, gerado pelo painel. */
export const BRANDING_KINDS = Object.freeze(['logo', 'favicon', 'icon']);

const LIMITS = Object.freeze({ logo: 512 * 1024, favicon: 128 * 1024, icon: 256 * 1024 });

/** Os caminhos que recebem a imagem crua — montados em `app.js` antes do parser JSON. */
export const BRANDING_UPLOAD_PATHS = BRANDING_KINDS.map((kind) => `/api/platform/settings/branding/${kind}`);

const CACHE_TTL_MS = 15_000;
let cache = null;

export function invalidatePlatformBranding() {
  cache = null;
}

export class PlatformBrandingError extends Error {
  constructor(message, { code, status = 400 } = {}) {
    super(message);
    this.name = 'PlatformBrandingError';
    this.code = code;
    this.status = status;
  }
}

/** O tipo que os primeiros bytes provam, ou null. O `Content-Type` é só uma declaração. */
export function sniffImage(buffer) {
  const b = buffer;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return 'image/x-icon';
  return null;
}

/**
 * O parser do corpo cru, com o 413 dito pelo código que a tela traduz. O teto é
 * o maior dos dois: o de cada tipo é conferido em `saveBrandingImage`.
 */
export const brandingRawBody = [
  express.raw({ type: () => true, limit: Math.max(...Object.values(LIMITS)) }),
  // Quatro argumentos de propósito: só assim o Express o trata como de erro.
  (err, req, res, next) => {
    if (err?.type !== 'entity.too.large') return next(err);
    return res.status(413).json({
      success: false,
      message: 'Image too large',
      code: 'branding_too_large'
    });
  }
];

async function lerGuardado() {
  if (cache && cache.expiresAt > Date.now()) return cache.value;
  const caixa = await Tenant.platform();
  let stored = {};
  if (caixa) {
    const bruto = await runInTenant(caixa.id, () => AppState.get(BRANDING_KEY));
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

/** O que as telas precisam saber: quais imagens existem e a versão de cada uma. */
export async function readBranding() {
  const { stored } = await lerGuardado();
  const out = {};
  for (const kind of BRANDING_KINDS) {
    const item = stored[kind];
    out[kind] = item?.data ? { updatedAt: item.updatedAt ?? null, mime: item.mime } : null;
  }
  return out;
}

/** Os bytes de uma imagem, ou null quando o console nunca enviou. */
export async function readBrandingImage(kind) {
  if (!BRANDING_KINDS.includes(kind)) return null;
  const { stored } = await lerGuardado();
  const item = stored[kind];
  if (!item?.data) return null;
  return { mime: item.mime, updatedAt: item.updatedAt, buffer: Buffer.from(item.data, 'base64') };
}

async function gravar(mutar) {
  const caixa = await Tenant.platform();
  if (!caixa) {
    throw new PlatformBrandingError('No platform tenant', { code: 'no_platform', status: 409 });
  }
  await runInTenant(caixa.id, async () => {
    const bruto = await AppState.get(BRANDING_KEY);
    let atual = {};
    try {
      const lido = bruto ? JSON.parse(bruto) : {};
      atual = lido && typeof lido === 'object' ? lido : {};
    } catch {
      atual = {};
    }
    mutar(atual);
    await AppState.upsert(BRANDING_KEY, JSON.stringify(atual));
  });
  invalidatePlatformBranding();
}

export async function saveBrandingImage(kind, buffer) {
  if (!BRANDING_KINDS.includes(kind)) {
    throw new PlatformBrandingError('Unknown kind', { code: 'invalid_kind' });
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new PlatformBrandingError('Empty body', { code: 'branding_empty' });
  }
  if (buffer.length > LIMITS[kind]) {
    throw new PlatformBrandingError('Image too large', { code: 'branding_too_large', status: 413 });
  }
  const mime = sniffImage(buffer);
  if (!mime) {
    throw new PlatformBrandingError('Unsupported image type', { code: 'branding_type_invalid', status: 415 });
  }
  await gravar((atual) => {
    atual[kind] = { mime, data: buffer.toString('base64'), updatedAt: new Date().toISOString() };
  });
}

export async function removeBrandingImage(kind) {
  if (!BRANDING_KINDS.includes(kind)) {
    throw new PlatformBrandingError('Unknown kind', { code: 'invalid_kind' });
  }
  await gravar((atual) => {
    delete atual[kind];
  });
}

export const BRANDING_LIMITS = LIMITS;
