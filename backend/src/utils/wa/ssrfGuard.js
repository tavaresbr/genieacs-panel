/**
 * Proteção anti-SSRF para qualquer requisição server-side feita a uma URL que
 * veio do usuário (a URL do servidor Evolution, a URL de uma mídia recebida).
 *
 * O padrão ingênuo — regex sobre a string do host, aplicado só à URL inicial —
 * deixa passar:
 *   - IPv6:                 http://[::1]/
 *   - IPv4 não-decimal:     http://2130706433/ , http://0x7f.1/ , http://127.1/
 *   - CGNAT:                100.64.0.0/10
 *   - nome DNS público → IP interno (inclui rebinding)
 *   - qualquer redirect, quando o fetch usa o default `redirect: 'follow'`
 *
 * Portado de compra-venda `supabase/functions/_shared/ssrf-guard.ts`. A única
 * diferença de comportamento é para melhor: lá a resolução de DNS era
 * best-effort porque dependia de `Deno.resolveDns`; aqui o `node:dns/promises`
 * está sempre disponível, então a checagem de "nome público apontando para IP
 * interno" é efetiva.
 */

import dns from 'node:dns/promises';

/**
 * Converte um host IPv4 em qualquer notação aceita por resolvers (dotted quad,
 * decimal, octal, hex e formas curtas tipo `127.1`) para inteiro 32 bits.
 * Retorna null quando o host não é um literal IPv4.
 */
export function parseIPv4(host) {
  const parts = String(host || '').split('.');
  if (parts.length === 0 || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!p) return null;
    let n;
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^\d+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // Na forma curta (a.b, a.b.c) o último campo absorve os octetos restantes.
  const last = nums.pop();
  if (last >= 256 ** (4 - nums.length)) return null;
  if (nums.some((n) => n > 255)) return null;
  let val = last;
  nums.forEach((n, i) => {
    val += n * 256 ** (3 - i);
  });
  return val >>> 0;
}

export function isPrivateIPv4(v) {
  const a = (v >>> 24) & 0xff;
  const b = (v >>> 16) & 0xff;
  if (a === 0) return true; //                           0.0.0.0/8
  if (a === 10) return true; //                          10/8
  if (a === 127) return true; //                         loopback
  if (a === 169 && b === 254) return true; //            link-local (metadados da cloud)
  if (a === 172 && b >= 16 && b <= 31) return true; //   172.16/12
  if (a === 192 && b === 168) return true; //            192.168/16
  if (a === 192 && b === 0) return true; //              192.0.0/24, 192.0.2/24
  if (a === 100 && b >= 64 && b <= 127) return true; //  CGNAT 100.64/10
  if (a >= 224) return true; //                          multicast + reservado
  return false;
}

export function isPrivateIPv6(host) {
  let h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  if (h === '::1' || h === '::') return true;
  if (/^f[cd]/.test(h)) return true; //    fc00::/7 (ULA)
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 (link-local)
  // IPv4-mapped / IPv4-compatible: ::ffff:127.0.0.1
  const m = h.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    const v = parseIPv4(m[1]);
    return v === null ? true : isPrivateIPv4(v);
  }
  return false;
}

/**
 * Bloqueio por literal, sem I/O. Nomes DNS públicos passam aqui e devem ser
 * verificados depois por resolvesToPrivate().
 */
export function isBlockedHost(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true;
  if (h.startsWith('[') || h.includes(':')) return isPrivateIPv6(h);
  const v4 = parseIPv4(h);
  if (v4 !== null) return isPrivateIPv4(v4);
  return false;
}

/**
 * Resolve o nome e rejeita se QUALQUER endereço cair em faixa interna — cobre
 * host público apontando para IP privado.
 *
 * Um nome que não resolve devolve false: quem barra aí é o próprio fetch, e
 * tratar NXDOMAIN como "privado" só produziria uma mensagem de erro errada. O
 * TOCTOU de DNS rebinding permanece inerente a qualquer verificação
 * pré-conexão.
 */
export async function resolvesToPrivate(host) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || h.includes(':') || parseIPv4(h) !== null) return false; // já coberto por isBlockedHost
  const [v4, v6] = await Promise.allSettled([dns.resolve4(h), dns.resolve6(h)]);
  const addrs = [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : [])
  ];
  return addrs.some((ip) => isBlockedHost(ip));
}

export class SsrfBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/**
 * Valida uma URL antes de qualquer requisição server-side. Lança
 * SsrfBlockedError quando o destino não é público.
 */
export async function assertPublicUrl(raw) {
  let u;
  try {
    u = raw instanceof URL ? raw : new URL(String(raw));
  } catch {
    throw new SsrfBlockedError('Invalid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new SsrfBlockedError('Unsupported protocol');
  if (isBlockedHost(u.hostname)) throw new SsrfBlockedError('Private host blocked');
  if (await resolvesToPrivate(u.hostname)) throw new SsrfBlockedError('Private host blocked');
  return u;
}

export const MAX_REDIRECTS = 3;

/**
 * Segue redirects manualmente, revalidando o host a CADA salto. Usar no lugar
 * de fetch() sempre que a URL de destino tiver origem no usuário.
 */
export async function safeFetch(start, init = {}, maxRedirects = MAX_REDIRECTS) {
  let current = start instanceof URL ? start : new URL(String(start));
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // eslint-disable-next-line no-await-in-loop -- os saltos são sequenciais por natureza
    await assertPublicUrl(current);
    // eslint-disable-next-line no-await-in-loop
    const r = await fetch(current.toString(), { ...init, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) return r;
      try {
        // eslint-disable-next-line no-await-in-loop
        await r.body?.cancel();
      } catch {
        /* corpo já descartado */
      }
      current = new URL(loc, current);
      continue;
    }
    return r;
  }
  throw new SsrfBlockedError('Too many redirects');
}
