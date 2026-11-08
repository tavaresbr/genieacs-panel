import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { call, startTestServers, stopTestServers } from './helpers/harness.js';

/**
 * Proteção de primeiro uso: com `SETUP_TOKEN` no ambiente, a primeira conta só
 * nasce com o código. Sem a variável, o comportamento é o de sempre.
 */
let panelUrl;
const CODIGO = 'codigo-de-instalacao-de-teste';
const corpo = (extra = {}) => ({
  username: 'dono', password: 'Senha-longa-de-teste-1!', email: 'dono@exemplo.test', ...extra
});

before(async () => {
  process.env.SETUP_TOKEN = CODIGO;
  ({ panelUrl } = await startTestServers());
});
after(async () => {
  delete process.env.SETUP_TOKEN;
  await stopTestServers();
});

describe('código de instalação no primeiro cadastro', () => {
  it('o status diz que precisa de código, sem revelá-lo', async () => {
    const { body } = await call(`${panelUrl}/api/auth/setup-status`);
    assert.equal(body.data.needsSetup, true);
    assert.equal(body.data.tokenRequired, true);
    assert.ok(!JSON.stringify(body).includes(CODIGO));
  });

  it('recusa sem código e com código errado (403), sem criar conta', async () => {
    for (const extra of [{}, { setupToken: 'errado' }]) {
      const { status, body } = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: corpo(extra) });
      assert.equal(status, 403, JSON.stringify(body));
      assert.equal(body.code, 'setup_token_invalid');
    }
    const { body } = await call(`${panelUrl}/api/auth/setup-status`);
    assert.equal(body.data.needsSetup, true, 'a conta foi criada mesmo recusada');
  });

  it('cria a conta com o código certo, no corpo', async () => {
    const { status, body } = await call(`${panelUrl}/api/auth/setup`, {
      method: 'POST', body: corpo({ setupToken: CODIGO })
    });
    assert.equal(status, 201, JSON.stringify(body));
  });

  it('depois do cadastro o status não pede mais código', async () => {
    const { body } = await call(`${panelUrl}/api/auth/setup-status`);
    assert.equal(body.data.needsSetup, false);
    assert.equal(body.data.tokenRequired, false);
  });
});
