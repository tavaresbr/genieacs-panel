/**
 * Política de destino do servidor Evolution: normalização da URL e allowlist.
 *
 * Portado de compra-venda `supabase/functions/_shared/evolution-policy.ts`.
 */

import { isHostAllowed as isHostAllowedGeneric } from './hostAllowlist.js';

export { extractHost, hostMatchesPattern, parseAllowedHosts } from './hostAllowlist.js';

/** Tira as barras do fim, sem expressão regular: `/\/+$/` fica quadrática numa URL cheia de `/`. */
function stripTrailingSlashes(text) {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 47) end -= 1;
  return text.slice(0, end);
}

const MANAGER = 'manager';

/** Onde está a ÚLTIMA quebra de linha (as que o `.` de uma expressão regular não atravessa), ou -1. */
function lastLineTerminator(text) {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const c = text.charCodeAt(i);
    if (c === 10 || c === 13 || c === 0x2028 || c === 0x2029) return i;
  }
  return -1;
}

/**
 * Corta no primeiro `/manager` (sem diferenciar maiúsculas) que vem seguido do
 * fim do texto, ou de `/` e de um resto SEM quebra de linha — o que
 * `/\/manager(\/.*)?$/i` fazia (o `.` não atravessa quebra de linha, e o `$` só
 * casa no fim do texto). Numa passada só, sem o retrocesso que uma expressão
 * regular sobre texto digitado permite.
 */
function cutManager(text) {
  const lastBreak = lastLineTerminator(text);
  for (let at = text.indexOf('/'); at !== -1; at = text.indexOf('/', at + 1)) {
    const end = at + 1 + MANAGER.length;
    if (text.slice(at + 1, end).toLowerCase() !== MANAGER) continue;
    if (end === text.length || (text[end] === '/' && lastBreak < end)) return text.slice(0, at);
  }
  return text;
}

/**
 * O Evolution publica o Manager (web UI) em /manager; a API REST responde na
 * raiz. É comum o operador colar a URL do Manager (ex.: .../manager/instances) —
 * removemos /manager e o que vier depois para não montar caminhos inválidos.
 *
 * A entrada é digitada pelo operador, então nada aqui usa expressão regular com
 * repetição: o resultado é o mesmo de antes (`test/evolution-policy.test.js`
 * confere contra a versão antiga), em tempo linear.
 */
export function normalizeEvoUrl(raw) {
  return stripTrailingSlashes(cutManager(stripTrailingSlashes(String(raw || '').trim())));
}

/**
 * Allowlist VAZIA = qualquer host público (o ssrfGuard segue barrando rede
 * interna). É o default: o provedor sobe o próprio servidor Evolution, então
 * exigir enumeração prévia inviabilizaria a integração. Preencher a lista é o
 * modo estrito.
 */
export function isHostAllowed(rawUrl, allowed) {
  return isHostAllowedGeneric(normalizeEvoUrl(rawUrl), allowed);
}
