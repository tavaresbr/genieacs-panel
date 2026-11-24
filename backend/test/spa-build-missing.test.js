import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Painel no ar sem o build do frontend (deploy quebrado): a página não existe e a
 * resposta tem de dizer isso SEM virar HTML. A frase vem traduzida pelo cabeçalho
 * `Accept-Language` da requisição, e uma frase entregue por `send` de string sai
 * como `text/html` — CodeQL: "Reflected cross-site scripting" / "Exception text
 * reinterpreted as HTML". Sai como JSON, no envelope de erro da API.
 */
// A pasta do build existe, mas sem o `index.html`: é quando a rota responde 503.
// (Sem a pasta o app nem monta as páginas e só serve a API.)
const emptyBuild = fs.mkdtempSync(path.join(os.tmpdir(), 'skygenpanel-empty-build-'));
process.env.FRONTEND_DIR = emptyBuild;

const { startTestServers, stopTestServers } = await import('./helpers/harness.js');

let panelUrl;

before(async () => {
  ({ panelUrl } = await startTestServers());
});

after(async () => {
  await stopTestServers();
  fs.rmSync(emptyBuild, { recursive: true, force: true });
});

describe('painel sem o build do frontend', () => {
  it('responde 503 em JSON, no envelope de erro, e nunca como HTML', async () => {
    const res = await fetch(`${panelUrl}/`, { headers: { Accept: 'text/html', 'Accept-Language': 'en' } });
    assert.equal(res.status, 503);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    const body = await res.json();
    assert.deepEqual(body, { success: false, message: 'The application build is unavailable', code: 'build_unavailable' });
  });

  it('a frase segue o idioma pedido', async () => {
    const res = await fetch(`${panelUrl}/qualquer-rota`, { headers: { 'Accept-Language': 'pt-BR' } });
    assert.equal(res.status, 503);
    assert.notEqual((await res.json()).message, 'The application build is unavailable');
  });

  it('um cabeçalho com marcação não entra na resposta', async () => {
    const res = await fetch(`${panelUrl}/`, { headers: { 'Accept-Language': '<script>alert(1)</script>' } });
    const text = await res.text();
    assert.equal(res.status, 503);
    assert.ok(!text.includes('<script>'), text);
  });
});
