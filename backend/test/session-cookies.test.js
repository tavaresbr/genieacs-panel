import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

// Esta suíte entra muitas vezes (um login por aparelho simulado): o balde do
// login, de 20 por endereço, é multiplicado só aqui — só vale com APP_ENV=test.
process.env.APP_ENV = 'test';
process.env.RATE_LIMIT_SCALE = '10';

const { authHeaders, call, getDb, startTestServers, stopTestServers } = await import('./helpers/harness.js');
const { CONSOLE_COOKIE, PANEL_COOKIE, cookieFrom, cookieHeaders, cookieLine } = await import('./helpers/sessionCookies.js');
const { default: RefreshToken, REFRESH_GRACE_MS } = await import('../src/models/RefreshToken.js');
const { default: AuditLog } = await import('../src/models/AuditLog.js');

/**
 * O login com cookie seguro e as sessões por aparelho (0129) — desenho em
 * `docs/seguranca-auditoria.md` §5.
 *
 * O que estes casos defendem:
 *
 * - o refresh só existe no cookie `HttpOnly; SameSite=Strict; Path=/api/auth`,
 *   guardado como hash, e gira a cada uso;
 * - um refresh já girado, reapresentado depois da folga, derruba a família
 *   inteira e deixa linha na trilha; dentro da folga (duas abas), as duas
 *   chamadas recebem o MESMO sucessor;
 * - as rotas do cookie recusam origem de fora e chamada sem o cabeçalho próprio;
 * - "Sair" encerra só este aparelho; "Sair de todos" encerra todos;
 * - o JWT antigo no corpo migra para uma família nova, uma vez.
 */
const DONO = { username: 'dono-sessoes', password: 'senha-das-sessoes-1', email: 'dono@sessoes.test' };

let panelUrl;

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, { method: 'POST', body: DONO });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
});

after(async () => {
  await stopTestServers();
});

/** Um aparelho: um login com o user agent dele. */
async function entrar(userAgent = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36') {
  const r = await call(`${panelUrl}/api/auth/login`, {
    method: 'POST', headers: { 'User-Agent': userAgent }, body: { username: DONO.username, password: DONO.password }
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { token: r.body.data.token, cookie: cookieFrom(r.response), response: r.response };
}

const renovar = (cookie, extra = {}) => call(`${panelUrl}/api/auth/refresh`, {
  method: 'POST', headers: cookieHeaders(cookie, PANEL_COOKIE, extra)
});

/** Empurra a rotação de um token para antes da folga, como se o tempo tivesse passado. */
async function envelhecerRotacao(cookie, ms = REFRESH_GRACE_MS + 30_000) {
  const antes = new Date(Math.floor((Date.now() - ms) / 1000) * 1000);
  await getDb()('refresh_tokens').where({ token_hash: RefreshToken.hash(cookie) }).update({ rotated_at: antes });
}

const usuario = (token) => call(`${panelUrl}/api/auth/user`, { headers: authHeaders(token) });

describe('o login', () => {
  it('põe o refresh no cookie HttpOnly, e nunca no corpo', async () => {
    const { token, cookie, response } = await entrar();
    assert.ok(cookie, 'sem cookie de refresh');
    const linha = cookieLine(response, PANEL_COOKIE);
    assert.match(linha, /HttpOnly/i);
    assert.match(linha, /SameSite=Strict/i);
    assert.match(linha, /Path=\/api\/auth(;|$)/);
    assert.match(linha, /Max-Age=604800/);
    // HTTP puro (o teste): sem `Secure`, e o nome sem prefixo.
    assert.doesNotMatch(linha, /;\s*Secure/i);

    // Só o hash no banco.
    assert.equal(await getDb()('refresh_tokens').where({ token_hash: cookie }).first(), undefined);
    const linhaDb = await RefreshToken.findByRaw(cookie);
    assert.ok(linhaDb);
    assert.match(linhaDb.user_agent, /Chrome/);

    // O token de acesso vale 15 minutos e nomeia a família.
    const claims = jwt.decode(token);
    assert.equal(claims.sid, linhaDb.family_id);
    assert.ok(claims.exp - claims.iat <= 15 * 60, `o acesso vale ${claims.exp - claims.iat}s`);
  });
});

describe('a renovação', () => {
  it('gira o token: o novo vale, o antigo fica marcado', async () => {
    const { cookie } = await entrar();
    const r = await renovar(cookie);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.data.token);
    assert.equal(r.body.data.refreshToken, undefined);
    const novo = cookieFrom(r.response);
    assert.ok(novo && novo !== cookie);
    assert.ok((await RefreshToken.findByRaw(cookie)).rotated_at, 'o token antigo não foi marcado como girado');
    assert.equal((await usuario(r.body.data.token)).status, 200);
    assert.equal((await renovar(novo)).status, 200);
  });

  it('reapresentado depois da folga é reuso: a família inteira cai, e fica na trilha', async () => {
    const { cookie } = await entrar('Mozilla/5.0 (Windows NT 10.0) Firefox/131.0');
    const r1 = await renovar(cookie);
    const sucessor = cookieFrom(r1.response);
    const acesso = r1.body.data.token;
    await envelhecerRotacao(cookie);

    const antes = await getDb()('audit_log').where({ action: AuditLog.ACTIONS.SESSION_REFRESH_REUSE }).count({ n: '*' });
    const reuso = await renovar(cookie);
    assert.equal(reuso.status, 401);
    assert.equal(reuso.body.code, 'refresh_reuse');
    assert.equal(cookieFrom(reuso.response), '', 'o cookie não foi apagado');

    // O sucessor legítimo caiu junto, e o token de acesso da família também.
    assert.equal((await renovar(sucessor)).status, 401);
    assert.equal((await usuario(acesso)).status, 403);

    const depois = await getDb()('audit_log').where({ action: AuditLog.ACTIONS.SESSION_REFRESH_REUSE }).count({ n: '*' });
    assert.equal(Number(depois[0].n), Number(antes[0].n) + 1);
    const linha = await getDb()('audit_log').where({ action: AuditLog.ACTIONS.SESSION_REFRESH_REUSE }).orderBy('id', 'desc').first();
    assert.ok(!String(linha.detail).includes(cookie), 'o token foi parar na trilha');
  });

  it('duas abas renovando juntas, dentro da folga, recebem o mesmo sucessor', async () => {
    const { cookie } = await entrar();
    const [a, b] = await Promise.all([renovar(cookie), renovar(cookie)]);
    assert.equal(a.status, 200, JSON.stringify(a.body));
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const ca = cookieFrom(a.response);
    const cb = cookieFrom(b.response);
    assert.equal(ca, cb, 'as duas abas ficaram com cookies diferentes');

    // A atrasada, em sequência, também (ainda dentro da folga) — e nada foi revogado.
    const c = await renovar(cookie);
    assert.equal(c.status, 200);
    assert.equal(cookieFrom(c.response), ca);
    assert.equal((await renovar(ca)).status, 200);
  });

  it('a resposta perdida: reenviar o token girado dentro da folga devolve o mesmo sucessor, sem revogar nem auditar', async () => {
    const reusos = async () => Number((await getDb()('audit_log').where({ action: AuditLog.ACTIONS.SESSION_REFRESH_REUSE }).count({ n: '*' }))[0].n);
    const antes = await reusos();
    const { cookie } = await entrar();
    const r1 = await renovar(cookie);
    assert.equal(r1.status, 200);
    const sucessor = cookieFrom(r1.response);
    const familia = (await RefreshToken.findByRaw(sucessor)).family_id;

    // A resposta de r1 não chegou: o navegador tenta de novo com o cookie antigo.
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await renovar(cookie);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(cookieFrom(r.response), sucessor, 'a repetição recebeu outro sucessor');
      assert.ok(r.body.data.token);
    }
    const linhas = await getDb()('refresh_tokens').where({ family_id: familia });
    assert.equal(linhas.length, 2, 'a repetição abriu um galho na família');
    assert.ok(linhas.every((l) => !l.revoked_at), 'a repetição revogou a família');
    assert.equal(await reusos(), antes, 'a repetição virou linha de reuso na trilha');
    assert.equal((await renovar(sucessor)).status, 200, 'o sucessor deixou de valer');
  });

  it('a folga é exata: dentro de REFRESH_GRACE_MS é a mesma renovação; depois, reuso', async () => {
    const user = await getDb()('users').where({ username: DONO.username }).first();
    for (const [atraso, esperado] of [[REFRESH_GRACE_MS - 1000, true], [REFRESH_GRACE_MS + 2000, false]]) {
      const { cookie } = await entrar();
      const girou = await renovar(cookie);
      const sucessor = cookieFrom(girou.response);
      const linha = await RefreshToken.findByRaw(cookie);
      const girouEm = new Date(linha.rotated_at).getTime();
      // eslint-disable-next-line no-await-in-loop
      const r = await RefreshToken.rotate({ raw: cookie, user, now: new Date(girouEm + atraso) });
      assert.equal(r.ok, esperado, `${atraso}ms: ${JSON.stringify(r.reason)}`);
      if (esperado) {
        assert.equal(r.raw, sucessor);
        assert.equal(r.grace, true);
        assert.equal((await RefreshToken.findByRaw(sucessor)).revoked_at, null);
      } else {
        assert.equal(r.reason, 'reuse');
        assert.ok((await RefreshToken.findByRaw(sucessor)).revoked_at, 'o reuso não revogou a família');
      }
    }
  });

  it('sem cookie é 401', async () => {
    const r = await renovar(null);
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'refresh_required');
  });

  it('cookie desconhecido é 401', async () => {
    const r = await renovar('nao-e-um-token-de-verdade');
    assert.equal(r.status, 401);
  });

  it('cookie vencido é 401', async () => {
    const { cookie } = await entrar();
    await getDb()('refresh_tokens').where({ token_hash: RefreshToken.hash(cookie) })
      .update({ expires_at: new Date(Math.floor((Date.now() - 60_000) / 1000) * 1000) });
    const r = await renovar(cookie);
    assert.equal(r.status, 401);
  });

  it('subir o token_version mata as famílias abertas', async () => {
    const { cookie, token } = await entrar();
    await getDb()('users').where({ username: DONO.username }).increment('token_version', 1);
    const r = await renovar(cookie);
    assert.equal(r.status, 401);
    assert.equal((await usuario(token)).status, 403);
    const linha = await RefreshToken.findByRaw(cookie);
    assert.ok(linha.revoked_at, 'a família da versão antiga não foi revogada');
  });
});

describe('a guarda de CSRF das rotas do cookie', () => {
  it('recusa origem de fora com 403, sem girar o token', async () => {
    const { cookie } = await entrar();
    const r = await renovar(cookie, { Origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    assert.equal((await RefreshToken.findByRaw(cookie)).rotated_at, null);
  });

  it('recusa Sec-Fetch-Site de outro site (inclusive um subdomínio vizinho)', async () => {
    const { cookie } = await entrar();
    for (const site of ['cross-site', 'same-site']) {
      const r = await renovar(cookie, { 'Sec-Fetch-Site': site });
      assert.equal(r.status, 403, site);
    }
    assert.equal((await renovar(cookie, { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  });

  it('recusa a chamada sem X-Requested-With: skygenpanel', async () => {
    const { cookie } = await entrar();
    for (const valor of [undefined, 'XMLHttpRequest']) {
      const headers = { Cookie: `${PANEL_COOKIE}=${cookie}` };
      if (valor) headers['X-Requested-With'] = valor;
      const r = await call(`${panelUrl}/api/auth/refresh`, { method: 'POST', headers });
      assert.equal(r.status, 403, String(valor));
      assert.equal(r.body.code, 'csrf_header_required');
    }
    const logout = await call(`${panelUrl}/api/auth/logout`, { method: 'POST', headers: { Cookie: `${PANEL_COOKIE}=${cookie}` } });
    assert.equal(logout.status, 403);
    assert.equal((await RefreshToken.findByRaw(cookie)).revoked_at, null);
  });
});

describe('sair e as sessões por aparelho', () => {
  it('"Sair" encerra só este aparelho: o outro continua renovando', async () => {
    const a = await entrar('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1');
    const b = await entrar('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15');
    const saiu = await call(`${panelUrl}/api/auth/logout`, {
      method: 'POST', headers: { ...authHeaders(a.token), ...cookieHeaders(a.cookie) }
    });
    assert.equal(saiu.status, 200);
    assert.equal(cookieFrom(saiu.response), '', 'o cookie deste aparelho não foi apagado');
    assert.equal((await renovar(a.cookie)).status, 401);
    assert.equal((await usuario(a.token)).status, 403, 'o token de acesso do aparelho que saiu continuou valendo');

    assert.equal((await usuario(b.token)).status, 200);
    assert.equal((await renovar(b.cookie)).status, 200, 'sair num aparelho derrubou o outro');
  });

  it('"Sair" sem token de acesso (ou com ele vencido) encerra pela família do cookie', async () => {
    const a = await entrar();
    const semToken = await call(`${panelUrl}/api/auth/logout`, { method: 'POST', headers: cookieHeaders(a.cookie) });
    assert.equal(semToken.status, 200);
    assert.equal((await renovar(a.cookie)).status, 401);

    const b = await entrar();
    const claims = jwt.decode(b.token);
    const vencido = jwt.sign(
      { userId: claims.userId, username: claims.username, tenantId: claims.tenantId, role: claims.role,
        tokenVersion: claims.tokenVersion, sid: claims.sid, iat: Math.floor(Date.now() / 1000) - 3600, exp: Math.floor(Date.now() / 1000) - 60 },
      process.env.JWT_SECRET, { issuer: 'skygenpanel', audience: 'skygenpanel-admin' }
    );
    const r = await call(`${panelUrl}/api/auth/logout`, { method: 'POST', headers: { ...authHeaders(vencido), 'X-Requested-With': 'skygenpanel' } });
    assert.equal(r.status, 200);
    assert.equal((await renovar(b.cookie)).status, 401, 'o token vencido não encerrou a família dele');
  });

  it('a saída atrasada não derruba a sessão nova que entrou na mesma aba', async () => {
    const velho = await entrar();
    const novo = await entrar();
    // A tela já esqueceu o token velho; o cookie do navegador agora é o novo.
    const r = await call(`${panelUrl}/api/auth/logout`, {
      method: 'POST', headers: { ...authHeaders(velho.token), ...cookieHeaders(novo.cookie) }
    });
    assert.equal(r.status, 200);
    assert.equal(cookieFrom(r.response), undefined, 'o cookie da sessão nova foi apagado');
    assert.equal((await renovar(velho.cookie)).status, 401);
    assert.equal((await renovar(novo.cookie)).status, 200);
  });

  it('lista as sessões, diz qual é esta, e encerra uma pelo id — só as da própria pessoa', async () => {
    await getDb()('refresh_tokens').update({ revoked_at: new Date(Math.floor(Date.now() / 1000) * 1000) });
    const aqui = await entrar('Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36');
    const ali = await entrar('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36');

    // A lista também exige o cabeçalho da guarda.
    const semCabecalho = await call(`${panelUrl}/api/auth/sessions`, { headers: authHeaders(aqui.token) });
    assert.equal(semCabecalho.status, 403);

    const lista = await call(`${panelUrl}/api/auth/sessions`, {
      headers: { ...authHeaders(aqui.token), 'X-Requested-With': 'skygenpanel' }
    });
    assert.equal(lista.status, 200, JSON.stringify(lista.body));
    const sessoes = lista.body.data.sessions;
    assert.equal(sessoes.length, 2);
    const atual = sessoes.find((s) => s.current);
    assert.equal(atual.id, jwt.decode(aqui.token).sid);
    assert.equal(atual.device, 'Chrome · Linux');
    const outra = sessoes.find((s) => !s.current);
    assert.equal(outra.device, 'Chrome · Android');
    assert.ok(outra.createdAt && outra.lastUsedAt);
    assert.equal(JSON.stringify(lista.body).includes(aqui.cookie), false, 'o cookie apareceu na lista');

    // Um id que não é desta pessoa (ou não existe) é 404, e não mexe em nada.
    const estranho = await call(`${panelUrl}/api/auth/sessions/00000000-0000-4000-8000-000000000000/revoke`, {
      method: 'POST', headers: { ...authHeaders(aqui.token), 'X-Requested-With': 'skygenpanel' }
    });
    assert.equal(estranho.status, 404);

    const encerrou = await call(`${panelUrl}/api/auth/sessions/${outra.id}/revoke`, {
      method: 'POST', headers: { ...authHeaders(aqui.token), 'X-Requested-With': 'skygenpanel' }
    });
    assert.equal(encerrou.status, 200);
    assert.equal(encerrou.body.data.current, false);
    assert.equal((await renovar(ali.cookie)).status, 401);
    assert.equal((await usuario(ali.token)).status, 403, 'encerrar não derrubou o token de acesso daquele aparelho');
    assert.equal((await usuario(aqui.token)).status, 200);
  });

  it('"Sair de todos" encerra todos os aparelhos, inclusive este', async () => {
    const a = await entrar();
    const b = await entrar();
    const r = await call(`${panelUrl}/api/auth/sessions/revoke-all`, {
      method: 'POST', headers: { ...authHeaders(a.token), 'X-Requested-With': 'skygenpanel' }
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    for (const aparelho of [a, b]) {
      assert.equal((await renovar(aparelho.cookie)).status, 401);
      assert.equal((await usuario(aparelho.token)).status, 403);
    }
    const abertas = await getDb()('refresh_tokens').whereNull('revoked_at').count({ n: '*' });
    assert.equal(Number(abertas[0].n), 0);
  });
});

describe('o cookie do console e o do painel', () => {
  it('não se misturam: o refresh de um não lê o cookie do outro', async () => {
    const { cookie } = await entrar();
    // O cookie do painel apresentado com o nome do console, na rota do console.
    const cruzado = await call(`${panelUrl}/api/auth/console/refresh`, {
      method: 'POST', headers: cookieHeaders(cookie, CONSOLE_COOKIE)
    });
    assert.equal(cruzado.status, 401);
    // E com o próprio nome, a rota do console nem o enxerga.
    const proprio = await call(`${panelUrl}/api/auth/console/refresh`, {
      method: 'POST', headers: cookieHeaders(cookie, PANEL_COOKIE)
    });
    assert.equal(proprio.status, 401);
    assert.equal(proprio.body.code, 'refresh_required');
    // Nada disso girou o token do painel.
    assert.equal((await RefreshToken.findByRaw(cookie)).rotated_at, null);
    assert.equal((await renovar(cookie)).status, 200);
  });
});

describe('a transição do refresh antigo (uma versão)', () => {
  // Cada JWT com o próprio `iat`: dois iguais no mesmo segundo seriam o mesmo token.
  let distinto = 0;
  const jwtAntigo = (user, extra = {}) => {
    distinto += 1;
    const iat = Math.floor(Date.now() / 1000) - 3600 - distinto;
    return jwt.sign(
      { userId: user.id, tenantId: extra.tenantId, tokenType: 'refresh', tokenVersion: Number(user.token_version || 0), iat, exp: extra.exp ?? iat + 7 * 24 * 3600 },
      process.env.JWT_SECRET,
      { issuer: 'skygenpanel', audience: 'skygenpanel-admin' }
    );
  };
  const migrar = (antigo) => call(`${panelUrl}/api/auth/refresh`, {
    method: 'POST', headers: cookieHeaders(null), body: { refreshToken: antigo }
  });
  const dono = async () => {
    const user = await getDb()('users').where({ username: DONO.username }).first();
    const membro = await getDb()('tenant_users').where({ user_id: user.id }).first();
    return { user, tenantId: membro.tenant_id };
  };
  const instante = (v) => new Date(v).getTime();

  it('converte o JWT do corpo numa família nova com cookie, uma vez', async () => {
    const user = await getDb()('users').where({ username: DONO.username }).first();
    const membro = await getDb()('tenant_users').where({ user_id: user.id }).first();
    const antigo = jwtAntigo(user, { tenantId: membro.tenant_id });

    const migrou = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST', headers: cookieHeaders(null), body: { refreshToken: antigo }
    });
    assert.equal(migrou.status, 200, JSON.stringify(migrou.body));
    const cookie = cookieFrom(migrou.response);
    assert.ok(cookie, 'a migração não pôs o cookie');
    assert.ok(jwt.decode(migrou.body.data.token).sid);
    assert.equal((await usuario(migrou.body.data.token)).status, 200);

    // Duas abas migrando o mesmo JWT: dentro da folga, o mesmo cookie.
    const denovo = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST', headers: cookieHeaders(null), body: { refreshToken: antigo }
    });
    assert.equal(denovo.status, 200, JSON.stringify(denovo.body));
    assert.equal(cookieFrom(denovo.response), cookie);

    // Depois da folga, o JWT antigo é um token girado reapresentado: reuso.
    await envelhecerRotacao(antigo);
    const tarde = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST', headers: cookieHeaders(null), body: { refreshToken: antigo }
    });
    assert.equal(tarde.status, 401);
    assert.equal((await renovar(cookie)).status, 401, 'o reuso do JWT antigo não derrubou a família migrada');
  });

  it('recusa o JWT antigo de outra versão da pessoa, ou um token de acesso no lugar', async () => {
    const user = await getDb()('users').where({ username: DONO.username }).first();
    const velho = jwtAntigo({ ...user, token_version: Number(user.token_version) - 1 });
    const r = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST', headers: cookieHeaders(null), body: { refreshToken: velho }
    });
    assert.equal(r.status, 401);
    const { token } = await entrar();
    const acesso = await call(`${panelUrl}/api/auth/refresh`, {
      method: 'POST', headers: cookieHeaders(null), body: { refreshToken: token }
    });
    assert.equal(acesso.status, 401);
  });

  it('a família convertida herda o vencimento do JWT, e a rotação não o estende', async () => {
    const { user, tenantId } = await dono();
    const exp = Math.floor(Date.now() / 1000) + 2 * 3600;
    const antigo = jwtAntigo(user, { tenantId, exp });
    const migrou = await migrar(antigo);
    assert.equal(migrou.status, 200, JSON.stringify(migrou.body));
    const cookie = cookieFrom(migrou.response);
    const raiz = await RefreshToken.findByRaw(antigo);
    const primeiro = await RefreshToken.findByRaw(cookie);
    assert.equal(instante(primeiro.family_expires_at), exp * 1000);
    assert.equal(instante(primeiro.expires_at), exp * 1000, 'a conversão ganhou sete dias novos');
    assert.equal(instante(raiz.expires_at), exp * 1000);

    // Girar não passa do teto.
    const girou = await renovar(cookie);
    assert.equal(girou.status, 200);
    const segundo = await RefreshToken.findByRaw(cookieFrom(girou.response));
    assert.equal(instante(segundo.expires_at), exp * 1000);
    assert.equal(instante(segundo.family_expires_at), exp * 1000);

    // Passado o teto, a família vence — mesmo tendo girado há pouco.
    const venceu = await RefreshToken.rotate({ raw: cookieFrom(girou.response), user, now: new Date((exp + 1) * 1000) });
    assert.equal(venceu.ok, false);
    assert.equal(venceu.reason, 'expired');

    // O login comum segue sem teto: sete dias renovados a cada uso.
    const comum = await entrar();
    const linha = await RefreshToken.findByRaw(comum.cookie);
    assert.equal(linha.family_expires_at, null);
    assert.ok(instante(linha.expires_at) > Date.now() + 6 * 24 * 3600_000);
  });

  it('o JWT antigo converte uma vez só: encerrada a família, a limpeza não o deixa converter de novo', async () => {
    const { user, tenantId } = await dono();
    const antigo = jwtAntigo(user, { tenantId });
    const migrou = await migrar(antigo);
    assert.equal(migrou.status, 200);
    const familia = (await RefreshToken.findByRaw(antigo)).family_id;
    // "Encerrar" a sessão na tela (sem subir a versão).
    await RefreshToken.revokeFamily(familia);
    // A limpeza de dois dias depois apaga revogados — mas não a linha do JWT,
    // que ainda tem a assinatura válida.
    await RefreshToken.prune(new Date(Date.now() + 2 * 24 * 3600_000));
    assert.ok(await RefreshToken.findByRaw(antigo), 'a limpeza apagou a linha do JWT antigo');
    const denovo = await migrar(antigo);
    assert.equal(denovo.status, 401);
    assert.equal((await getDb()('refresh_tokens').where({ user_id: user.id }).whereNull('revoked_at').where({ family_id: familia })).length, 0);
    // Depois do teto (e da folga da limpeza), sai.
    await RefreshToken.prune(new Date(Date.now() + 9 * 24 * 3600_000));
    assert.equal(await RefreshToken.findByRaw(antigo), null);
  });

  it('"Sair" de uma sessão convertida sobe o token_version: o JWT antigo morre, e as outras sessões também', async () => {
    const { user, tenantId } = await dono();
    const antigo = jwtAntigo(user, { tenantId });
    const copia = jwtAntigo(user, { tenantId });
    const migrou = await migrar(antigo);
    assert.equal(migrou.status, 200);
    const outro = await entrar();
    const r = await call(`${panelUrl}/api/auth/logout`, {
      method: 'POST', headers: { ...authHeaders(migrou.body.data.token), ...cookieHeaders(cookieFrom(migrou.response)) }
    });
    assert.equal(r.status, 200);
    assert.equal(cookieFrom(r.response), '');
    const depois = await getDb()('users').where({ id: user.id }).first();
    assert.equal(Number(depois.token_version), Number(user.token_version) + 1, 'a saída da sessão convertida não subiu a versão');
    // Um outro JWT antigo da mesma versão (outra aba, uma cópia) não converte mais.
    assert.equal((await migrar(copia)).status, 401);
    assert.equal((await renovar(outro.cookie)).status, 401);
  });

  it('"Sair" só pelo cookie de uma sessão convertida também sobe a versão', async () => {
    const { user, tenantId } = await dono();
    const migrou = await migrar(jwtAntigo(user, { tenantId }));
    assert.equal(migrou.status, 200);
    const r = await call(`${panelUrl}/api/auth/logout`, { method: 'POST', headers: cookieHeaders(cookieFrom(migrou.response)) });
    assert.equal(r.status, 200);
    const depois = await getDb()('users').where({ id: user.id }).first();
    assert.equal(Number(depois.token_version), Number(user.token_version) + 1);
  });

  it('"Sair" com um token de acesso de antes da 0129 (sem sid) sobe a versão — e um de versão já morta não', async () => {
    const outro = await entrar();
    const { user, tenantId } = await dono();
    const claims = jwt.decode(outro.token);
    const semSid = jwt.sign(
      { userId: claims.userId, username: claims.username, tenantId: claims.tenantId, role: claims.role, tokenVersion: claims.tokenVersion },
      process.env.JWT_SECRET, { issuer: 'skygenpanel', audience: 'skygenpanel-admin', expiresIn: '15m' }
    );
    const r = await call(`${panelUrl}/api/auth/logout`, { method: 'POST', headers: { ...authHeaders(semSid), 'X-Requested-With': 'skygenpanel' } });
    assert.equal(r.status, 200);
    const depois = await getDb()('users').where({ id: user.id }).first();
    assert.equal(Number(depois.token_version), Number(user.token_version) + 1);
    assert.equal((await migrar(jwtAntigo(user, { tenantId }))).status, 401);
    assert.equal((await renovar(outro.cookie)).status, 401);

    // O mesmo token, agora de uma versão morta, não derruba as sessões de hoje.
    const hoje = await entrar();
    const r2 = await call(`${panelUrl}/api/auth/logout`, { method: 'POST', headers: { ...authHeaders(semSid), 'X-Requested-With': 'skygenpanel' } });
    assert.equal(r2.status, 200);
    assert.equal((await renovar(hoje.cookie)).status, 200);
  });
});
