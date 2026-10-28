import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A vitrine para quem não executa JavaScript: o `<head>` e o texto que o
 * servidor coloca no `index.html`, só no ápice, e o fechamento em qualquer outro
 * host. O build é um `index.html` de verdade (o do frontend), copiado para uma
 * pasta temporária — é ele que traz os marcadores que o servidor troca.
 */
process.env.EDITION = 'saas';
process.env.TENANT_BASE_DOMAIN = 'painel.test';
process.env.PLATFORM_EXTRA_HOSTS = 'site.test';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.join(AQUI, '..', '..', 'frontend');
const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skygenpanel-seo-'));
fs.copyFileSync(path.join(FRONTEND, 'index.html'), path.join(buildDir, 'index.html'));
process.env.FRONTEND_DIR = buildDir;

const { startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { buildJsonLd, buildNoscript, renderSeo, normalizePath } = await import('../src/services/seoHead.js');
const { FAQ, FEATURES, STEPS } = await import('../src/services/seoContent.js');
const { llmsFor } = await import('../src/services/seoFiles.js');

let panelUrl;

function callAs(host, pathname) {
  const target = new URL(`${panelUrl}${pathname}`);
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: target.hostname, port: target.port, path: target.pathname + target.search, method: 'GET', headers: { Host: host }
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

const PLANOS = [
  { code: 'pro', name: 'Pro', description: 'Para provedores médios', features: [], limits: { devices: 500, subscribers: null, operators: 5 }, priceCents: 19900, priceYearlyCents: null, currency: 'BRL', periodDays: 30, trialDays: 7, featured: true }
];

function jsonLdDe(html) {
  const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(m, 'sem JSON-LD');
  return JSON.parse(m[1]);
}

before(async () => {
  ({ panelUrl } = await startTestServers());
});

after(async () => {
  await stopTestServers();
  fs.rmSync(buildDir, { recursive: true, force: true });
});

describe('a vitrine no ápice', () => {
  it('entrega título, canonical, Open Graph, JSON-LD e o texto, sem JavaScript', async () => {
    const res = await callAs('site.test', '/');
    assert.equal(res.status, 200);
    assert.match(res.text, /<title>[^<]*Gestão TR-069 para provedores de internet<\/title>/);
    assert.match(res.text, /<meta name="description" content="Plataforma completa de gestão TR-069/);
    assert.match(res.text, /<link rel="canonical" href="https:\/\/site\.test\/" \/>/);
    assert.match(res.text, /<meta property="og:title"/);
    assert.match(res.text, /<meta name="robots" content="index, follow/);
    assert.match(res.text, /<noscript>[\s\S]*<h1>Gerencie os roteadores/);
    assert.doesNotMatch(res.text, /<!--seo-/, 'um marcador vazou para a página');

    const grafo = jsonLdDe(res.text)['@graph'].map((no) => no['@type']);
    assert.deepEqual(grafo, ['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage']);
  });

  it('o www. do ápice também, e o canonical segue o host do pedido', async () => {
    const res = await callAs('www.site.test', '/');
    assert.match(res.text, /<link rel="canonical" href="https:\/\/www\.site\.test\/" \/>/);
  });

  it('/signup e /privacidade têm título e canonical próprios, sem JSON-LD nem texto da vitrine', async () => {
    for (const [rota, titulo] of [['/signup', 'Criar conta'], ['/privacidade', 'Política de privacidade']]) {
      const res = await callAs('site.test', rota);
      assert.match(res.text, new RegExp(`<title>${titulo}`));
      assert.ok(res.text.includes(`<link rel="canonical" href="https://site.test${rota}" />`), `sem canonical em ${rota}`);
      assert.doesNotMatch(res.text, /application\/ld\+json/);
      assert.doesNotMatch(res.text, /<noscript>/);
    }
  });

  it('a entrada fica fora dos resultados, mas não vira bloqueio', async () => {
    const res = await callAs('site.test', '/login');
    assert.match(res.text, /<meta name="robots" content="noindex, follow" \/>/);
    assert.doesNotMatch(res.text, /rel="canonical"/);
  });
});

describe('qualquer outro host', () => {
  it('um painel de provedor sai noindex, sem conteúdo da vitrine', async () => {
    for (const host of ['acme.painel.test', 'painel.test.evil.com', 'localhost']) {
      const res = await callAs(host, '/');
      assert.match(res.text, /<meta name="robots" content="noindex, nofollow" \/>/, host);
      assert.doesNotMatch(res.text, /application\/ld\+json|<noscript>|rel="canonical"/, host);
      assert.doesNotMatch(res.text, /<!--seo-/);
    }
  });
});

describe('o llms.txt', () => {
  it('existe no ápice e resume a plataforma; fora dele é 404', async () => {
    const res = await callAs('site.test', '/llms.txt');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/markdown/);
    assert.match(res.text, /^# TR69 Controle/);
    assert.match(res.text, /## Dúvidas frequentes/);
    assert.match(res.text, /\(https:\/\/site\.test\/signup\)/);

    assert.equal((await callAs('acme.painel.test', '/llms.txt')).status, 404);
  });

  it('lista os planos com preço e período de teste', () => {
    const texto = llmsFor({ platformHost: true, host: 'site.test', plans: PLANOS });
    assert.match(texto, /\*\*Pro\*\*: R\$\s?199,00 por mês\. 500 equipamentos, assinantes ilimitados, 5 operadores, 7 dias grátis\./);
    assert.match(texto, /\(https:\/\/site\.test\/signup\?plano=pro\)/);
    assert.equal(llmsFor({ platformHost: false, host: 'acme.painel.test' }), null);
  });
});

describe('os dados estruturados e o texto', () => {
  it('SoftwareApplication leva uma Offer por plano; sem planos, sem offers', () => {
    const com = buildJsonLd({ base: 'https://site.test', plans: PLANOS })['@graph'].find((no) => no['@type'] === 'SoftwareApplication');
    assert.equal(com.offers.length, 1);
    assert.equal(com.offers[0].price, '199.00');
    assert.equal(com.offers[0].priceCurrency, 'BRL');
    const sem = buildJsonLd({ base: 'https://site.test', plans: [] })['@graph'].find((no) => no['@type'] === 'SoftwareApplication');
    assert.equal(sem.offers, undefined);
  });

  it('um texto com "<" nunca fecha o script nem entra cru no HTML', () => {
    const html = '<html><head><title>x</title><!--seo-head--></head><body><!--seo-body--></body></html>';
    const planos = [{ ...PLANOS[0], name: '</script><img src=x onerror=alert(1)>' }];
    const saida = renderSeo({ html, platformHost: true, host: 'site.test', pathname: '/', plans: planos });
    assert.doesNotMatch(saida, /<img src=x/);
    assert.equal((saida.match(/<\/script>/g) || []).length, 1);
    assert.equal(jsonLdDe(saida)['@graph'][2].offers[0].name, '</script><img src=x onerror=alert(1)>');
    assert.match(buildNoscript({ base: 'https://site.test', plans: planos }), /&lt;\/script&gt;/);
  });

  it('sem os marcadores, o HTML ainda recebe a troca (antes de </head> e depois de <body>)', () => {
    const html = '<html><head><title>x</title></head><body><div id="root"></div></body></html>';
    const saida = renderSeo({ html, platformHost: true, host: 'site.test', pathname: '/', plans: [] });
    assert.match(saida, /rel="canonical"[\s\S]*<\/head>/);
    assert.match(saida, /<body><noscript>/);
  });

  it('/signup/ é /signup', () => {
    assert.equal(normalizePath('/signup/'), '/signup');
    assert.equal(normalizePath('/'), '/');
  });
});

describe('o texto do servidor e o da vitrine dizem o mesmo', () => {
  const fonte = fs.readFileSync(path.join(FRONTEND, 'src', 'components', 'landing', 'content.ts'), 'utf8');
  const ptBR = fonte.slice(fonte.indexOf('const ptBR: LandingCopy'), fonte.indexOf('const en: LandingCopy'));

  it('as perguntas e respostas do FAQ', () => {
    assert.ok(ptBR.length > 1000, 'o bloco pt-BR de content.ts mudou de forma: reveja esta leitura');
    for (const item of FAQ) {
      assert.ok(ptBR.includes(item.q), `pergunta fora da vitrine: ${item.q}`);
      assert.ok(ptBR.includes(item.a), `resposta fora da vitrine: ${item.a}`);
    }
  });

  it('os recursos e os passos', () => {
    for (const item of [...FEATURES, ...STEPS]) {
      assert.ok(ptBR.includes(item.title), `título fora da vitrine: ${item.title}`);
      assert.ok(ptBR.includes(item.text), `texto fora da vitrine: ${item.text}`);
    }
  });
});
