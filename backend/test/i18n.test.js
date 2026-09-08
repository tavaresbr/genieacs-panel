import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { call, startTestServers, stopTestServers } from './helpers/harness.js';
import { dictionaries, LOCALES, translate } from '../src/i18n/index.js';
import { negotiateLocale, parseAcceptLanguage, resolveLocale } from '../src/i18n/config.js';

let panelUrl;
let portalUrl;

before(async () => {
  ({ panelUrl, portalUrl } = await startTestServers());
});

after(async () => {
  await stopTestServers();
});

describe('dictionaries', () => {
  it('translates every English key in every other locale', () => {
    const expected = Object.keys(dictionaries.en).sort();
    for (const locale of LOCALES) {
      assert.deepEqual(
        Object.keys(dictionaries[locale]).sort(),
        expected,
        `${locale} does not cover the same keys as en`
      );
    }
  });

  it('keeps the placeholders of every English string', () => {
    const placeholders = (text) => (text.match(/\{\w+\}/g) || []).sort().join(',');
    for (const [key, template] of Object.entries(dictionaries.en)) {
      for (const locale of LOCALES) {
        assert.equal(
          placeholders(dictionaries[locale][key]),
          placeholders(template),
          `${locale}.${key} does not use the same placeholders as en.${key}`
        );
      }
    }
  });

  it('interpolates variables and falls back to English for a missing key', () => {
    assert.equal(
      translate('pt-BR', 'settings.connectionStatus', { status: 503 }),
      'O servidor GenieACS respondeu com status 503'
    );
    assert.equal(translate('es', 'common.routeNotFound'), 'Ruta no encontrada');
    assert.equal(translate('de', 'common.routeNotFound'), 'Route nicht gefunden');
    assert.equal(translate('pt-BR', 'nonexistent.key'), 'nonexistent.key');
  });
});

describe('locale negotiation', () => {
  it('resolves regional tags to a supported locale', () => {
    assert.equal(resolveLocale('pt'), 'pt-BR');
    assert.equal(resolveLocale('PT-pt'), 'pt-BR');
    assert.equal(resolveLocale('es-419'), 'es');
    assert.equal(resolveLocale('en-GB'), 'en');
    assert.equal(resolveLocale('it-CH'), 'it');
    assert.equal(resolveLocale('de-AT'), 'de');
    assert.equal(resolveLocale('fr'), null);
  });

  it('orders Accept-Language entries by quality', () => {
    assert.deepEqual(
      parseAcceptLanguage('fr;q=0.4, es;q=0.9, en;q=0.6'),
      ['es', 'en', 'fr']
    );
    assert.deepEqual(parseAcceptLanguage(''), []);
  });

  it('picks the first supported language and defaults to pt-BR', () => {
    assert.equal(negotiateLocale('fr-FR, es;q=0.8'), 'es');
    assert.equal(negotiateLocale('de-DE'), 'de');
    assert.equal(negotiateLocale('fr-FR'), 'pt-BR');
    assert.equal(negotiateLocale(undefined), 'pt-BR');
    assert.equal(negotiateLocale('*'), 'pt-BR');
  });
});

describe('translated responses', () => {
  it('answers in Portuguese by default', async () => {
    const { status, body, response } = await call(`${panelUrl}/api/does-not-exist`);
    assert.equal(status, 404);
    assert.equal(body.message, 'Rota não encontrada');
    assert.equal(response.headers.get('content-language'), 'pt-BR');
  });

  it('honours the Accept-Language header', async () => {
    for (const [header, message] of [
      ['en', 'Route not found'],
      ['es', 'Ruta no encontrada'],
      ['it', 'Rotta non trovata'],
      ['de', 'Route nicht gefunden'],
      ['fr;q=0.9, en;q=0.5', 'Route not found']
    ]) {
      const { body } = await call(`${panelUrl}/api/does-not-exist`, {
        headers: { 'Accept-Language': header }
      });
      assert.equal(body.message, message);
    }
  });

  it('translates authentication failures', async () => {
    const { status, body } = await call(`${panelUrl}/api/devices`, {
      headers: { 'Accept-Language': 'es' }
    });
    assert.equal(status, 401);
    assert.equal(body.message, 'Se requiere el token de autenticación');
  });

  it('translates portal session failures', async () => {
    const { status, body } = await call(`${portalUrl}/api/customer/overview`, {
      headers: { 'Accept-Language': 'en' }
    });
    assert.equal(status, 401);
    assert.equal(body.message, 'A customer session is required');
  });

  it('varies on Accept-Language so proxies keep the languages apart', async () => {
    const { response } = await call(`${panelUrl}/api/does-not-exist`);
    assert.match(response.headers.get('vary') || '', /Accept-Language/i);
  });
});
