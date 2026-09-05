import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Every environment variable the application reads at import time has to be in
// place before the modules under test are loaded, so the imports below are
// deliberately dynamic.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skygenpanel-test-'));
process.env.DATA_DIR = dataDir;
process.env.APP_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-for-production-rules';
process.env.PORTAL_JWT_SECRET = 'test-portal-secret-that-is-long-enough-for-tests';
process.env.CORS_ORIGINS = 'http://localhost:5890';
// Assigned rather than deleted: dotenv does not overwrite variables that are
// already set, so an unset value would be repopulated from a developer's .env.
process.env.TRUST_PROXY = '0';
process.env.PORTAL_COOKIE_SECURE = 'auto';

const { app, portalApp } = await import('../../src/app.js');
const { ensureSchema } = await import('../../src/config/schema.js');
const { seedDefaults } = await import('../../src/config/seed.js');
const { getDb, closePool } = await import('../../src/config/database.js');

export { app, portalApp, getDb };

const listeners = [];

function listen(target) {
  return new Promise((resolve) => {
    const server = target.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * Boots a fresh schema plus both listeners and returns their base URLs.
 * `beforeSchema` runs first, so a test can lay down an older table layout and
 * exercise the upgrade path.
 */
export async function startTestServers({ beforeSchema } = {}) {
  if (beforeSchema) await beforeSchema(getDb());
  await ensureSchema();
  await seedDefaults();
  const [panel, portal] = await Promise.all([listen(app), listen(portalApp)]);
  listeners.push(panel, portal);
  return {
    panelUrl: `http://127.0.0.1:${panel.address().port}`,
    portalUrl: `http://127.0.0.1:${portal.address().port}`
  };
}

export async function stopTestServers() {
  await Promise.all(listeners.splice(0).map(
    (server) => new Promise((resolve) => server.close(resolve))
  ));
  await closePool();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

/** fetch wrapper that always returns the parsed body alongside the response. */
export async function call(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual'
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, status: response.status, body };
}

export function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}
