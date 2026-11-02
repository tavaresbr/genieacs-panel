import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';

/**
 * A regra da senha NOVA (`src/utils/passwordPolicy.js`) e o limitador da
 * troca de senha.
 *
 * O que se prende aqui: 10+ caracteres, fora das comuns e diferente do login
 * em toda rota que ESCOLHE senha — e só nelas. A senha antiga de 8 caracteres
 * continua entrando pelo login e servindo de "senha atual" na troca: a regra
 * não pode trancar ninguém do lado de fora.
 */
const {
  authHeaders, call, getDb, startTestServers, stopTestServers
} = await import('./helpers/harness.js');
const {
  PASSWORD_MIN_LENGTH, isCommonPassword, matchesIdentity, newPasswordProblem
} = await import('../src/utils/passwordPolicy.js');
const { assertCorsOriginsSafe, wantsUpgradeInsecureRequests } = await import('../src/config/runtimeEnv.js');

const DONA = { username: 'dona', password: 'senha-da-dona-1', email: 'dona@exemplo.test' };

let panelUrl;
let donaToken;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: DONA });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  donaToken = setup.body.data.token;
});

after(async () => {
  await stopTestServers();
});

describe('a regra, isolada', () => {
  it('pede 10 caracteres', () => {
    assert.equal(PASSWORD_MIN_LENGTH, 10);
    assert.equal(newPasswordProblem('nove-char')?.code, 'password_length');
    assert.equal(newPasswordProblem('x'.repeat(129))?.code, 'password_length');
    assert.equal(newPasswordProblem('dez-chars!'), null);
  });

  it('recusa as comuns sem olhar maiúsculas, as sequências e o caractere repetido', () => {
    for (const comum of ['Password123', 'QWERTYUIOP', '1234567890', 'senha12345', 'abcdefghijkl', 'aaaaaaaaaaaa', '9876543210']) {
      assert.ok(isCommonPassword(comum), comum);
      assert.equal(newPasswordProblem(comum)?.code, 'password_too_common', comum);
    }
    assert.ok(!isCommonPassword('cavalo-bateria-grampo'));
  });

  it('recusa a senha igual ao usuário, ao e-mail ou à parte antes do @', () => {
    const id = { username: 'operador.joao', email: 'joao.silva@provedor.test' };
    assert.ok(matchesIdentity('Operador.Joao', id));
    assert.ok(matchesIdentity('joao.silva@provedor.test', id));
    assert.ok(matchesIdentity('joao.silva', { email: id.email }));
    assert.equal(newPasswordProblem('joao.silva@provedor.test', id)?.code, 'password_matches_identity');
    assert.equal(newPasswordProblem('outra-senha-boa', id), null);
  });
});

describe('as rotas que escolhem senha', () => {
  it('criar operador recusa a curta e a comum, com código estável', async () => {
    const curta = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(donaToken),
      body: { username: 'curto', password: 'nove-char', email: 'curto@exemplo.test', role: 'tech' }
    });
    assert.equal(curta.status, 400);
    assert.equal(curta.body.code, 'password_length');
    assert.match(curta.body.message, /10/);

    const comum = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: { ...authHeaders(donaToken), 'Accept-Language': 'pt-BR' },
      body: { username: 'comum', password: 'Password123', email: 'comum@exemplo.test', role: 'tech' }
    });
    assert.equal(comum.status, 400);
    assert.equal(comum.body.code, 'password_too_common');
    assert.match(comum.body.message, /comum/);

    const igual = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(donaToken),
      body: { username: 'igualzinho', password: 'igualzinho@exemplo.test', email: 'igualzinho@exemplo.test', role: 'tech' }
    });
    assert.equal(igual.status, 400);
    assert.equal(igual.body.code, 'password_matches_identity');
  });

  it('a senha antiga de 8 caracteres continua entrando, e a troca só cobra a NOVA', async () => {
    // Uma conta de antes da regra, com senha de 8 — gravada direto no banco,
    // como estaria num deploy atualizado.
    const criada = await call(`${panelUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders(donaToken),
      body: { username: 'antiga', password: 'senha-provisoria-1', email: 'antiga@exemplo.test', role: 'tech' }
    });
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    await getDb()('users').where({ username: 'antiga' }).update({ password: await bcrypt.hash('oito1234', 4) });

    const login = await call(`${panelUrl}/api/auth/login`, {
      method: 'POST', body: { username: 'antiga', password: 'oito1234' }
    });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const token = login.body.data.token;

    const trocar = (newPassword) => call(`${panelUrl}/api/auth/change-password`, {
      method: 'POST', headers: authHeaders(token), body: { currentPassword: 'oito1234', newPassword }
    });
    assert.equal((await trocar('nove-char')).body.code, 'password_length');
    assert.equal((await trocar('qwerty12345')).body.code, 'password_too_common');
    assert.equal((await trocar('antiga@exemplo.test')).body.code, 'password_matches_identity');
    const ok = await trocar('cavalo-bateria-grampo');
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});

describe('o limitador da troca de senha', () => {
  it('responde 429 depois de vinte tentativas da mesma pessoa', async () => {
    let ultimo;
    for (let i = 0; i < 21; i += 1) {
      // Corpo inválido de propósito (sem senha atual): não toca na trava por
      // conta, só no balde da rota.
      // eslint-disable-next-line no-await-in-loop
      ultimo = await call(`${panelUrl}/api/auth/change-password`, {
        method: 'POST', headers: authHeaders(donaToken), body: {}
      });
      if (i < 20) assert.equal(ultimo.status, 400, `tentativa ${i + 1}: ${JSON.stringify(ultimo.body)}`);
    }
    assert.equal(ultimo.status, 429);
  });
});

describe('o arranque em produção', () => {
  it('recusa CORS_ORIGINS=* só em produção', () => {
    assert.throws(() => assertCorsOriginsSafe(['*'], true), /CORS_ORIGINS='\*' is not allowed in production/);
    assert.throws(() => assertCorsOriginsSafe(['https://a.test', ' * '], true));
    assert.doesNotThrow(() => assertCorsOriginsSafe(['*'], false));
    assert.doesNotThrow(() => assertCorsOriginsSafe(['https://painel.exemplo.test'], true));
  });

  it('upgrade-insecure-requests só quando pedido', () => {
    assert.equal(wantsUpgradeInsecureRequests({}), false);
    assert.equal(wantsUpgradeInsecureRequests({ CSP_UPGRADE_INSECURE_REQUESTS: 'true' }), true);
    assert.equal(wantsUpgradeInsecureRequests({ CSP_UPGRADE_INSECURE_REQUESTS: '1' }), false);
  });
});
