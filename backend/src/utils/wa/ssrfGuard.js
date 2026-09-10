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

/** Dois hextetos como o IPv4 de 32 bits que eles soletram. */
function hextetsToIPv4(hi, lo) {
  return (((parseInt(hi, 16) << 16) | parseInt(lo, 16)) >>> 0);
}

/**
 * O IPv4 que um literal IPv6 carrega dentro de si, ou nada.
 *
 * Três formatos embutem um endereço IPv4, e os três precisam ser reconhecidos
 * na grafia que o `new URL()` PRODUZ, não na que uma pessoa escreve. O
 * serializador do WHATWG sempre emite hextetos: `::ffff:127.0.0.1` chega aqui
 * como `::ffff:7f00:1`. Casar só a forma decimal é casar nada do que vem de uma
 * URL analisada — era exatamente esse o furo.
 *
 * Devolve `undefined` quando não há IPv4 embutido, e `null` quando há um mas
 * ele não analisa. Quem chama trata os dois de forma diferente de propósito: um
 * endereço malformado que diz carregar um IPv4 é recusado, não liberado.
 */
function embeddedIPv4(h) {
  // 6to4 (2002::/16): o IPv4 são os dois hextetos logo depois do prefixo.
  const sixToFour = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/);
  if (sixToFour) return hextetsToIPv4(sixToFour[1], sixToFour[2]);

  // IPv4-mapped (::ffff:x), IPv4-compatible (::x) e NAT64 (64:ff9b::x).
  const tail = h.match(/^(?:::(?:ffff:)?|64:ff9b::)(.+)$/);
  if (!tail) return undefined;
  const rest = tail[1];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(rest)) return parseIPv4(rest);
  const pair = rest.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (pair) return hextetsToIPv4(pair[1], pair[2]);
  return undefined;
}

export function isPrivateIPv6(host) {
  let h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  const zone = h.indexOf('%');
  if (zone >= 0) h = h.slice(0, zone);
  if (h === '::1' || h === '::') return true;
  if (/^f[cd]/.test(h)) return true; //    fc00::/7 (ULA)
  if (/^fe[89ab]/.test(h)) return true; // fe80::/10 (link-local)
  const embedded = embeddedIPv4(h);
  if (embedded !== undefined) {
    return embedded === null ? true : isPrivateIPv4(embedded);
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
export async function resolvesToPrivate(host, signal) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!h || h.includes(':') || parseIPv4(h) !== null) return false; // já coberto por isBlockedHost
  // Já cancelado antes de começar: não há consulta a fazer, e quem chama vai
  // terminar pelo próprio sinal logo em seguida.
  if (signal?.aborted) return false;

  // Um resolver próprio por consulta, e não o `dns.resolve4` do módulo, porque
  // este tem `cancel()` e aquele não tem: é o que permite ABANDONAR a consulta
  // quando o prazo vence, em vez de apenas parar de esperar por ela e deixar
  // uma pergunta pendurada no processo.
  const resolver = new dns.Resolver();
  // Um resolver novo lê a configuração do sistema, e não os servidores do
  // resolver padrão: sem isto, um `dns.setServers()` em algum ponto do boot
  // valeria para o resto do processo e silenciosamente não valeria aqui.
  try {
    const servidores = dns.getServers();
    if (servidores.length > 0) resolver.setServers(servidores);
  } catch {
    /* lista inválida: fica com a do sistema, que é o que havia antes */
  }
  const cancelar = () => resolver.cancel();
  signal?.addEventListener('abort', cancelar, { once: true });
  try {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(h), resolver.resolve6(h)]);
    const addrs = [
      ...(v4.status === 'fulfilled' ? v4.value : []),
      ...(v6.status === 'fulfilled' ? v6.value : [])
    ];
    return addrs.some((ip) => isBlockedHost(ip));
  } finally {
    signal?.removeEventListener('abort', cancelar);
  }
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
 *
 * O `signal` é opcional e serve só para pôr a resolução de nome sob o mesmo
 * prazo da requisição que ela precede. Uma consulta cancelada não devolve
 * endereço nenhum, então esta função responde "não é privado" — e quem chama
 * termina pelo sinal, que é a razão verdadeira de a chamada acabar. Reportar
 * "host privado" por causa de um prazo vencido seria dizer ao operador uma
 * coisa que não aconteceu.
 */
export async function assertPublicUrl(raw, signal) {
  let u;
  try {
    u = raw instanceof URL ? raw : new URL(String(raw));
  } catch {
    throw new SsrfBlockedError('Invalid URL');
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new SsrfBlockedError('Unsupported protocol');
  if (isBlockedHost(u.hostname)) throw new SsrfBlockedError('Private host blocked');
  if (await resolvesToPrivate(u.hostname, signal)) throw new SsrfBlockedError('Private host blocked');
  return u;
}

export const MAX_REDIRECTS = 3;

/**
 * Quanto tempo uma busca inteira pode levar, do primeiro salto ao último byte.
 *
 * O `fetch` do Node não tem prazo nenhum por conta própria, e sem um destes o
 * host de destino escolhe por quanto tempo prende quem chamou: manda os
 * cabeçalhos, depois pinga um byte por minuto, e o handler do webhook que
 * aguarda esta função nunca devolve o socket. `waWebhookLimiter` conta chegadas,
 * não requisições simultâneas, então nada limitava quantas ficavam presas ao
 * mesmo tempo. O teto de 25 MB em `lerCorpoLimitado` limita o tamanho, não o
 * tempo — são coisas diferentes e cada uma precisa do seu limite.
 *
 * Um prazo SÓ, criado antes do laço e compartilhado por todos os saltos, e não
 * um por salto: três saltos com 30 s cada seriam 90 s de espera, que é
 * justamente o que se quer evitar.
 *
 * E vale da resolução do nome ao último byte, não só do `fetch` em diante. A
 * verificação anti-SSRF consulta o DNS antes de qualquer conexão, e um
 * resolver que não responde prende quem chamou exatamente como um servidor que
 * não responde — mesma espera, mesmo handler preso, um passo antes.
 */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Segue redirects manualmente, revalidando o host a CADA salto. Usar no lugar
 * de fetch() sempre que a URL de destino tiver origem no usuário.
 *
 * `init.timeoutMs` substitui o prazo padrão para quem baixa arquivo grande. O
 * `signal` de quem chama continua valendo: os dois são combinados, então o
 * cancelamento vem do que disparar primeiro, e o combinado governa tanto a
 * resolução de nome de cada salto quanto a requisição em si.
 */
export async function safeFetch(start, init = {}, maxRedirects = MAX_REDIRECTS) {
  const { timeoutMs = FETCH_TIMEOUT_MS, signal: callerSignal, ...rest } = init;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, deadline]) : deadline;

  let current = start instanceof URL ? start : new URL(String(start));
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    // eslint-disable-next-line no-await-in-loop -- os saltos são sequenciais por natureza
    await assertPublicUrl(current, signal);
    // O prazo pode ter vencido DENTRO da resolução acima. Sem isto a decisão
    // de encerrar ficaria por conta do `fetch`, que é justamente o passo que o
    // prazo existe para não deixar começar.
    signal.throwIfAborted();
    // eslint-disable-next-line no-await-in-loop
    const r = await fetch(current.toString(), { ...rest, signal, redirect: 'manual' });
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
