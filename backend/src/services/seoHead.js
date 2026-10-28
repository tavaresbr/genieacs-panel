import Plan from '../models/Plan.js';
import { presentPublicPlan } from '../controllers/publicController.js';
import {
  FAQ, FEATURES, SEO_PAGES, SITE_LOCALE, SITE_NAME, SITE_TAGLINE, STEPS, VENDORS
} from './seoContent.js';

/**
 * O `<head>` e o texto da vitrine para quem não executa JavaScript.
 *
 * A vitrine é uma SPA: o HTML que o servidor entrega é `<div id="root">` e
 * nada mais, e é esse HTML que a maioria dos robôs de IA e das pré-visualizações
 * de link lê. Aqui o servidor troca, **só no ápice e só nas páginas públicas**,
 * os marcadores de `index.html` por título, descrição, canonical, Open Graph,
 * dados estruturados (JSON-LD) e um `<noscript>` com o conteúdo.
 *
 * Em qualquer outro host ou caminho a troca é a contrária: `noindex, nofollow`,
 * e nenhum conteúdo da vitrine. É o painel de um provedor, e não deve aparecer
 * numa busca — a mesma regra do `robots.txt` (`seoFiles.js`), repetida na
 * página porque `robots.txt` bloqueia o rastreio, mas não impede uma URL
 * linkada por fora de aparecer nos resultados.
 */

const HEAD_MARKER = '<!--seo-head-->';
const BODY_MARKER = '<!--seo-body-->';
const PLANS_TTL_MS = 5 * 60 * 1000;

let plansCache = { at: 0, plans: [] };

/** O catálogo público, com cache curto. Falha em silêncio: sem planos a página só não tem `Offer`. */
export async function loadPublicPlans() {
  if (Date.now() - plansCache.at < PLANS_TTL_MS) return plansCache.plans;
  try {
    const rows = await Plan.listPublic();
    plansCache = { at: Date.now(), plans: rows.map(presentPublicPlan) };
  } catch (error) {
    console.warn(`SEO plans lookup failed: ${error.message}`);
    plansCache = { at: Date.now() - PLANS_TTL_MS + 30_000, plans: plansCache.plans };
  }
  return plansCache.plans;
}

export function resetPlansCache() {
  plansCache = { at: 0, plans: [] };
}

/** `/signup/` e `/signup` são a mesma página; a raiz é a raiz. */
export function normalizePath(pathname) {
  const limpo = String(pathname || '/').split('?')[0];
  return limpo.length > 1 ? limpo.replace(/\/+$/, '') : '/';
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** JSON dentro de `<script>`: `<` escapado, para que um texto nunca feche a tag. */
function jsonScript(data) {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function origin(host) {
  const limpo = String(host || '').trim().toLowerCase();
  if (!limpo || !/^[a-z0-9.-]+$/.test(limpo)) return null;
  return `https://${limpo}`;
}

function brl(cents, currency = 'BRL') {
  try {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: currency || 'BRL' }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function periodText(plan) {
  if (plan.periodDays === 30) return 'por mês';
  if (plan.periodDays === 365) return 'por ano';
  return `a cada ${plan.periodDays} dias`;
}

function limitsText(plan) {
  const parts = [];
  const one = (value, label) => parts.push(value === null ? `${label} ilimitados` : `${value} ${label}`);
  one(plan.limits?.devices ?? null, 'equipamentos');
  one(plan.limits?.subscribers ?? null, 'assinantes');
  one(plan.limits?.operators ?? null, 'operadores');
  return parts.join(', ');
}

export function buildJsonLd({ base, plans }) {
  const offers = plans.map((plan) => ({
    '@type': 'Offer',
    name: plan.name,
    description: [plan.description, limitsText(plan), plan.trialDays > 0 ? `${plan.trialDays} dias grátis` : null].filter(Boolean).join(' · '),
    price: (plan.priceCents / 100).toFixed(2),
    priceCurrency: plan.currency || 'BRL',
    url: `${base}/signup?plano=${encodeURIComponent(plan.code)}`,
    availability: 'https://schema.org/InStock'
  }));

  const graph = [
    {
      '@type': 'Organization',
      '@id': `${base}/#organization`,
      name: SITE_NAME,
      url: `${base}/`,
      logo: `${base}/apple-touch-icon.png`,
      description: SITE_TAGLINE
    },
    {
      '@type': 'WebSite',
      '@id': `${base}/#website`,
      url: `${base}/`,
      name: SITE_NAME,
      inLanguage: SITE_LOCALE,
      publisher: { '@id': `${base}/#organization` }
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${base}/#software`,
      name: SITE_NAME,
      url: `${base}/`,
      description: SEO_PAGES['/'].description,
      applicationCategory: 'BusinessApplication',
      operatingSystem: 'Web',
      inLanguage: SITE_LOCALE,
      featureList: FEATURES.map((feature) => feature.title),
      publisher: { '@id': `${base}/#organization` },
      ...(offers.length > 0 ? { offers } : {})
    },
    {
      '@type': 'FAQPage',
      '@id': `${base}/#faq`,
      mainEntity: FAQ.map((item) => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a }
      }))
    }
  ];
  return { '@context': 'https://schema.org', '@graph': graph };
}

/** O conteúdo da vitrine em HTML simples, para quem não roda JavaScript. */
export function buildNoscript({ base, plans }) {
  const page = SEO_PAGES['/'];
  const planos = plans.length === 0 ? '' : `
    <h2>Planos</h2>
    <ul>${plans.map((plan) => `
      <li><strong>${esc(plan.name)}</strong>: ${plan.priceCents === 0 ? 'Grátis' : `${esc(brl(plan.priceCents, plan.currency))} ${periodText(plan)}`}.
        ${esc(limitsText(plan))}.${plan.trialDays > 0 ? ` ${plan.trialDays} dias grátis.` : ''}
        <a href="${esc(`${base}/signup?plano=${encodeURIComponent(plan.code)}`)}">Contratar</a></li>`).join('')}
    </ul>`;

  return `<noscript>
  <main>
    <h1>${esc(page.heading)}</h1>
    <p>${esc(page.description)}</p>
    <h2>Recursos</h2>
    <ul>${FEATURES.map((feature) => `<li><strong>${esc(feature.title)}</strong>: ${esc(feature.text)}</li>`).join('')}</ul>
    <h2>Compatível com os principais fabricantes</h2>
    <p>${esc(VENDORS.join(', '))}.</p>
    <h2>Como funciona</h2>
    <ol>${STEPS.map((step) => `<li><strong>${esc(step.title)}</strong>: ${esc(step.text)}</li>`).join('')}</ol>${planos}
    <h2>Dúvidas frequentes</h2>
    ${FAQ.map((item) => `<h3>${esc(item.q)}</h3><p>${esc(item.a)}</p>`).join('\n    ')}
    <p><a href="${esc(`${base}/signup`)}">Criar conta</a> · <a href="${esc(`${base}/privacidade`)}">Política de privacidade</a></p>
  </main>
</noscript>`;
}

function indexableHead({ base, pathname, page, plans }) {
  const url = `${base}${pathname === '/' ? '/' : pathname}`;
  const tags = [
    `<link rel="canonical" href="${esc(url)}" />`,
    '<meta name="robots" content="index, follow, max-snippet:-1, max-image-preview:large, max-video-preview:-1" />',
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(SITE_NAME)}" />`,
    `<meta property="og:locale" content="pt_BR" />`,
    `<meta property="og:title" content="${esc(page.title)}" />`,
    `<meta property="og:description" content="${esc(page.description)}" />`,
    `<meta property="og:url" content="${esc(url)}" />`,
    `<meta property="og:image" content="${esc(`${base}/apple-touch-icon.png`)}" />`,
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${esc(page.title)}" />`,
    `<meta name="twitter:description" content="${esc(page.description)}" />`
  ];
  if (pathname === '/') {
    tags.push(`<script type="application/ld+json">${jsonScript(buildJsonLd({ base, plans }))}</script>`);
  }
  return tags.join('\n    ');
}

function put(html, marker, fallbackAnchor, where, content) {
  if (html.includes(marker)) return html.replace(marker, content);
  const at = html.indexOf(fallbackAnchor);
  if (at === -1) return html;
  const cut = where === 'after' ? at + fallbackAnchor.length : at;
  return `${html.slice(0, cut)}${content}${html.slice(cut)}`;
}

/**
 * O `index.html` desta requisição.
 *
 * `platformHost` já vem conferido contra a allowlist do ápice (`isPlatformHost`);
 * sem ele, ou fora das páginas públicas, a página sai `noindex, nofollow`.
 */
export function renderSeo({ html, platformHost, host, pathname, plans = [] }) {
  const path = normalizePath(pathname);
  const page = SEO_PAGES[path];
  const base = origin(host);

  if (!platformHost || !page || !base) {
    const fechado = '<meta name="robots" content="noindex, nofollow" />';
    return put(put(html, HEAD_MARKER, '</head>', 'before', fechado), BODY_MARKER, '<body>', 'after', '');
  }

  if (page.noindex) {
    // A entrada: liberada no robots.txt para não parecer bloqueio, mas fora dos resultados.
    const aberta = '<meta name="robots" content="noindex, follow" />';
    return put(put(html, HEAD_MARKER, '</head>', 'before', aberta), BODY_MARKER, '<body>', 'after', '');
  }

  let out = html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(page.title)}</title>`)
    .replace(/<meta\s+name="description"[^>]*>/i, `<meta name="description" content="${esc(page.description)}" />`);
  out = put(out, HEAD_MARKER, '</head>', 'before', indexableHead({ base, pathname: path, page, plans }));
  out = put(out, BODY_MARKER, '<body>', 'after', path === '/' ? buildNoscript({ base, plans }) : '');
  return out;
}
