import { PRODUCT_NAME } from '../config/brand.js';
import Tenant from '../models/Tenant.js';
import { panelBaseDomain, tenantSlugFromHost } from '../middleware/tenantResolver.js';
import { readBranding } from './platformBrandingService.js';
import { readProfile } from './platformProfileService.js';

/**
 * O manifest do app do provedor (PWA, 0130): o que o Chrome/Android e o
 * Safari leem para "Instalar app" / "Adicionar à Tela de Início".
 *
 * Por host, como o `robots.txt`: no endereço de um provedor o app instalado
 * leva o nome dele (é o painel DELE que a pessoa instala), em qualquer outro
 * o nome do produto. O nome do produto é o do perfil da plataforma (nome
 * fantasia), com a marca do código como reserva.
 *
 * Os ícones: sem marca enviada pelo console, os três padrão do build
 * (`frontend/public/pwa-*.png` — 192, 512 e o maskable com margem de
 * segurança). Com o ícone de tela de início enviado (180×180, opaco), ele
 * passa a ser o ÚNICO: o launcher do Android prefere o maskable, e manter o
 * padrão ao lado faria o app instalado mostrar a marca errada. JPEG e ICO não
 * contam — o Chrome só aceita PNG/WebP/SVG para instalar —, e aí ficam os
 * padrões.
 */

export const THEME_COLOR = '#173f35';
export const BACKGROUND_COLOR = '#f6f5f1';

export const DEFAULT_ICONS = Object.freeze([
  { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
]);

const INSTALAVEL = new Set(['image/png', 'image/webp']);

function cortar(texto, max) {
  const limpo = String(texto ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
  return limpo.length > max ? limpo.slice(0, max).trim() : limpo;
}

/** O nome do provedor dono do host, ou null (ápice, IP, domínio próprio). */
async function provedorDoHost(host) {
  const base = panelBaseDomain();
  if (!base) return null;
  const slug = tenantSlugFromHost(host, [base]);
  if (!slug) return null;
  const tenant = await Tenant.findBySlug(slug).catch(() => null);
  if (!tenant || tenant.kind === 'platform' || tenant.status !== 'active') return null;
  return cortar(tenant.name, 60) || null;
}

/** O manifest como objeto. `deps` existe para o teste trocar as leituras. */
export async function buildManifest({ host = '' } = {}, deps = {}) {
  const lerPerfil = deps.readProfile ?? readProfile;
  const lerMarca = deps.readBranding ?? readBranding;
  const lerProvedor = deps.provider ?? provedorDoHost;

  const perfil = await lerPerfil().catch(() => null);
  const produto = cortar(perfil?.values?.tradeName, 40) || PRODUCT_NAME;
  const provedor = await lerProvedor(host).catch(() => null);
  const marca = await lerMarca().catch(() => null);

  const icone = marca?.icon && INSTALAVEL.has(marca.icon.mime)
    ? [{
      src: `/api/tenant/brand/icon?v=${encodeURIComponent(marca.icon.updatedAt ?? '')}`,
      sizes: '180x180',
      type: marca.icon.mime,
      purpose: 'any'
    }]
    : null;

  return {
    id: '/',
    name: provedor ? `${provedor} · ${produto}` : produto,
    short_name: cortar(provedor || produto, 24),
    description: produto,
    lang: 'pt-BR',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    theme_color: THEME_COLOR,
    background_color: BACKGROUND_COLOR,
    icons: icone ?? DEFAULT_ICONS.map((i) => ({ ...i }))
  };
}

export default buildManifest;
