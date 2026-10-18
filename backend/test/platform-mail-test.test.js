import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

/**
 * O "Enviar e-mail de teste" do console: prova o SMTP do deploy mandando uma
 * mensagem de verdade e diz POR QUE falhou, sem devolver o texto do erro (que
 * pode trazer o servidor e o usuário do SMTP).
 *
 * O SMTP é um de mentira, em processo; nada sai desta máquina.
 */
process.env.EDITION = 'saas';

const { authHeaders, call, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { smtpDeMentira, decodificarQuotedPrintable } = await import('./helpers/fakeSmtp.js');
const { resetMailTransport, classifyMailError } = await import('../src/services/mail/index.js');
const { saveProfile, invalidatePlatformProfile } = await import('../src/services/platformProfileService.js');

let panelUrl;
let token;
let smtp;
let recebidas;
let smtpPort;

before(async () => {
  ({ server: smtp, recebidas } = smtpDeMentira());
  await new Promise((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  smtpPort = smtp.address().port;

  ({ panelUrl } = await startTestServers());
  const db = getDb();
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST', body: { username: 'owner', password: 'owner-senha-1', email: 'owner@exemplo.test' }
  });
  assert.equal(setup.status, 201);
  token = setup.body.data.token;
  if (!(await db('platform_admins').where({ user_id: setup.body.data.user.id }).first())) {
    await db('platform_admins').insert({ user_id: setup.body.data.user.id });
  }
  await db('tenants').insert({ slug: 'plataforma', name: 'Plataforma', status: 'active', kind: 'platform' });
  invalidatePlatformProfile();
  await saveProfile({ notifyEmail: 'ops@plataforma.test' });
});

after(async () => {
  resetMailTransport();
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
  await stopTestServers();
  await new Promise((resolve) => smtp.close(resolve));
});

function usarSmtp(url) {
  if (url) {
    process.env.SMTP_URL = url;
    process.env.MAIL_FROM = 'TR69 Controle <nao-responda@exemplo.test>';
  } else {
    delete process.env.SMTP_URL;
    delete process.env.MAIL_FROM;
  }
  resetMailTransport();
}

const testar = (body, headers = authHeaders(token)) => call(`${panelUrl}/api/platform/mail/test`, {
  method: 'POST', body, headers
});

describe('o e-mail de teste', () => {
  it('sem SMTP no deploy é 409 not_configured', async () => {
    usarSmtp(null);
    const res = await testar({ to: 'alguem@exemplo.test' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'not_configured');
  });

  it('manda a mensagem para o endereço pedido', async () => {
    usarSmtp(`smtp://usuario:senha@127.0.0.1:${smtpPort}?ignoreTLS=true`);
    recebidas.length = 0;
    const res = await testar({ to: 'alguem@exemplo.test' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.sent, true);
    assert.equal(recebidas.length, 1);
    assert.match(recebidas[0], /To: alguem@exemplo\.test/);
    assert.match(recebidas[0], /From: TR69 Controle <nao-responda@exemplo\.test>/);
    assert.match(decodificarQuotedPrintable(recebidas[0]), /e-mail de teste/i);
  });

  it('sem destino pedido, usa o e-mail de avisos de Dados do SaaS', async () => {
    usarSmtp(`smtp://usuario:senha@127.0.0.1:${smtpPort}?ignoreTLS=true`);
    recebidas.length = 0;
    const res = await testar({});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(recebidas[0], /To: ops@plataforma\.test/);
  });

  it('endereço inválido é 400 e não manda nada', async () => {
    usarSmtp(`smtp://usuario:senha@127.0.0.1:${smtpPort}?ignoreTLS=true`);
    recebidas.length = 0;
    const res = await testar({ to: 'nao-e-endereco' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'invalid_email');
    assert.equal(recebidas.length, 0);
  });

  it('SMTP fora do ar é 502 com o motivo, sem vazar o servidor nem a senha', async () => {
    usarSmtp('smtp://usuario-secreto:senha-secreta@127.0.0.1:1?ignoreTLS=true');
    const res = await testar({ to: 'alguem@exemplo.test' });
    assert.equal(res.status, 502);
    assert.equal(res.body.code, 'send_failed');
    assert.equal(res.body.reason, 'connection');
    const texto = JSON.stringify(res.body);
    assert.doesNotMatch(texto, /usuario-secreto|senha-secreta|127\.0\.0\.1/);
  });

  it('registra na trilha sem o destino', async () => {
    const trilha = await getDb()('platform_audit').where({ action: 'platform.mail_test' }).orderBy('id', 'desc').first();
    assert.ok(trilha);
    assert.equal(trilha.detail.includes('alguem@exemplo.test'), false);
    assert.equal(trilha.detail.includes('senha-secreta'), false);
  });

  it('não existe para quem não é do console', async () => {
    const res = await testar({ to: 'alguem@exemplo.test' }, {});
    assert.equal(res.status, 401);
  });
});

describe('classifyMailError', () => {
  it('traduz os erros do nodemailer em códigos', () => {
    assert.equal(classifyMailError({ code: 'EAUTH' }), 'auth');
    assert.equal(classifyMailError({ responseCode: 535 }), 'auth');
    assert.equal(classifyMailError({ code: 'ETIMEDOUT' }), 'timeout');
    assert.equal(classifyMailError({ code: 'PROBE_TIMEOUT' }), 'timeout');
    assert.equal(classifyMailError({ code: 'ECONNECTION' }), 'connection');
    assert.equal(classifyMailError({ code: 'EDNS' }), 'connection');
    assert.equal(classifyMailError({ code: 'EENVELOPE', responseCode: 550 }), 'rejected');
    assert.equal(classifyMailError({ code: 'ESOCKET', message: 'wrong version number (SSL routines)' }), 'tls');
    assert.equal(classifyMailError(new Error('x')), 'unknown');
  });
});
