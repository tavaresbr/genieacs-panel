/**
 * O cookie do refresh (0129) nos testes, sem navegador: o `fetch` do Node não
 * guarda cookie, então a suíte lê o `Set-Cookie` e o devolve à mão.
 *
 * Em HTTP (que é o que os testes sobem) o nome é sem prefixo — `skg_rt` no
 * painel e `skg_crt` no console; ver `middleware/sessionCookie.js`.
 */
export const PANEL_COOKIE = 'skg_rt';
export const CONSOLE_COOKIE = 'skg_crt';

/** O valor que a resposta pôs no cookie `name`; `''` se o apagou; `undefined` se não mexeu. */
export function cookieFrom(response, name = PANEL_COOKIE) {
  const all = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const line of all) {
    const [pair] = String(line).split(';');
    const eq = pair.indexOf('=');
    if (eq < 1 || pair.slice(0, eq).trim() !== name) continue;
    const value = decodeURIComponent(pair.slice(eq + 1).trim());
    if (/expires=Thu, 01 Jan 1970/i.test(line) || /max-age=0/i.test(line)) return '';
    return value;
  }
  return undefined;
}

/** A linha inteira do `Set-Cookie` de `name`, para conferir os atributos. */
export function cookieLine(response, name = PANEL_COOKIE) {
  const all = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  return all.find((line) => line.startsWith(`${name}=`)) ?? null;
}

/** Os cabeçalhos de uma chamada às rotas do cookie: o cookie e o `X-Requested-With`. */
export function cookieHeaders(value, name = PANEL_COOKIE, extra = {}) {
  return {
    'X-Requested-With': 'skygenpanel',
    ...(value ? { Cookie: `${name}=${encodeURIComponent(value)}` } : {}),
    ...extra
  };
}
