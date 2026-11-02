import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import util from 'node:util';

const {
  REDACTED,
  installTenantTaggedConsole,
  logLine,
  redactSecrets,
  redactText,
  setLogSink
} = await import('../src/utils/logger.js');

/**
 * A redação de credenciais nos logs: no logger estruturado e no `console`
 * embrulhado. O caso que a motivou é o erro de um cliente HTTP, que carrega o
 * cabeçalho `Authorization` e o corpo enviado — e um `console.error(err)`
 * imprimia tudo.
 */
function erroDeCliente() {
  const erro = new Error('Request failed with status code 401 (Authorization: Bearer abc.def.ghi)');
  erro.code = 'ERR_BAD_REQUEST';
  erro.config = {
    url: 'https://sgp.exemplo.test/api?token=tok-da-query&page=2',
    headers: { Authorization: 'Bearer segredo-do-cabecalho', 'Content-Type': 'application/json', access_token: 'tok-2' },
    data: '{"password":"senha-enviada","name":"fulano"}'
  };
  erro.response = { status: 401, data: { message: 'bad', apikey: 'chave-da-resposta', pixKey: 'pix@exemplo.test' } };
  return erro;
}

describe('redactText', () => {
  it('mascara Bearer, pares chave=valor e JSON em texto', () => {
    const limpo = redactText('Authorization: Bearer eyJ.abc.def ?access_token=xyz&b=2 {"password":"p1","ok":"sim"} apikey=K');
    assert.ok(!limpo.includes('eyJ.abc.def'));
    assert.ok(!limpo.includes('xyz'));
    assert.ok(!limpo.includes('p1'));
    assert.ok(!limpo.includes('=K'));
    assert.ok(limpo.includes('"ok":"sim"'));
    assert.ok(limpo.includes('b=2'));
  });

  it('deixa em paz o texto comum', () => {
    const texto = 'Server running on 127.0.0.1:5890 (production) — token expired for user 42';
    assert.equal(redactText(texto), texto);
  });
});

describe('redactSecrets', () => {
  it('limpa o erro de um cliente HTTP sem mexer no original', () => {
    const erro = erroDeCliente();
    const limpo = redactSecrets(erro);
    const impresso = util.inspect(limpo, { depth: 5 });

    for (const segredo of ['abc.def.ghi', 'segredo-do-cabecalho', 'tok-da-query', 'tok-2', 'senha-enviada', 'chave-da-resposta', 'pix@exemplo.test']) {
      assert.ok(!impresso.includes(segredo), `vazou ${segredo}: ${impresso}`);
    }
    assert.ok(impresso.includes('ERR_BAD_REQUEST'));
    assert.ok(impresso.includes('application/json'));
    assert.ok(limpo instanceof Error);
    assert.equal(limpo.config.headers.Authorization, REDACTED);

    // O original segue intacto para quem ainda vai tratá-lo.
    assert.equal(erro.config.headers.Authorization, 'Bearer segredo-do-cabecalho');
    assert.equal(erro.response.data.apikey, 'chave-da-resposta');
  });

  it('mantém flags e contadores sob nomes parecidos', () => {
    const limpo = redactSecrets({ tokenVersion: 3, webhookSecretConfigured: true, token: 'abc', senha: 'x', nested: { secret: { a: 1 } } });
    assert.equal(limpo.tokenVersion, 3);
    assert.equal(limpo.webhookSecretConfigured, true);
    assert.equal(limpo.token, REDACTED);
    assert.equal(limpo.senha, REDACTED);
    assert.equal(limpo.nested.secret, REDACTED);
  });

  it('aguenta ciclo e nunca lança', () => {
    const a = { nome: 'a' };
    a.eu = a;
    const limpo = redactSecrets(a);
    assert.equal(limpo.eu, '[Circular]');
    assert.equal(redactSecrets(null), null);
    assert.equal(redactSecrets(42), 42);
  });
});

describe('o logger estruturado', () => {
  it('não escreve credencial nem em campos nem no erro', () => {
    const linhas = [];
    setLogSink((linha) => linhas.push(linha));
    try {
      process.env.LOG_FORMAT = 'json';
      logLine('error', 'falhou com Bearer abc.def.ghi', { err: erroDeCliente(), authorization: 'Basic dXNlcjpzZW5oYQ==', body: { password: 'p', ok: 1 } });
      process.env.LOG_FORMAT = 'text';
      logLine('error', 'falhou', { err: erroDeCliente(), token: 'tok-solto' });
    } finally {
      delete process.env.LOG_FORMAT;
      setLogSink(null);
    }
    const tudo = linhas.join('\n');
    for (const segredo of ['abc.def.ghi', 'dXNlcjpzZW5oYQ', 'tok-solto', '"password":"p"']) {
      assert.ok(!tudo.includes(segredo), `vazou ${segredo}: ${tudo}`);
    }
    assert.ok(tudo.includes('"ok":1'));
  });
});

describe('o console embrulhado', () => {
  it('passa cada argumento pela redação', () => {
    const vistos = [];
    const fake = {
      log: (...a) => vistos.push(a),
      info: (...a) => vistos.push(a),
      warn: (...a) => vistos.push(a),
      error: (...a) => vistos.push(a),
      debug: (...a) => vistos.push(a)
    };
    installTenantTaggedConsole(fake);
    fake.error('SGP request error:', erroDeCliente());
    fake.warn('tentativa com password=hunter2');
    const impresso = vistos.map((args) => args.map((a) => util.inspect(a, { depth: 5 })).join(' ')).join('\n');
    for (const segredo of ['segredo-do-cabecalho', 'senha-enviada', 'hunter2', 'chave-da-resposta']) {
      assert.ok(!impresso.includes(segredo), `vazou ${segredo}: ${impresso}`);
    }
    assert.equal(vistos[0][0], 'SGP request error:');
  });
});
