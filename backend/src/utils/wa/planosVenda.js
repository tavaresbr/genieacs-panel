/**
 * Quais planos a IA mostra a quem ainda não é cliente: no máximo DOIS.
 *
 * O primeiro é o que mais combina com o perfil que a pessoa demonstrou; o
 * segundo é o vizinho (economia → equilibrado; equilibrado → premium, ou
 * econômico se não houver premium; qualidade → equilibrado). Sem perfil, o
 * plano de entrada e o equilibrado. Plano inativo ou sem preço nunca sai.
 */

export const PERFIS_DE_PLANO = Object.freeze(['economico', 'equilibrado', 'premium']);

/** O que a IA diz sobre o cliente → o perfil de plano que atende. */
const DO_CLIENTE = { economico: 'economico', equilibrado: 'equilibrado', qualidade: 'premium', premium: 'premium' };

const VIZINHO = {
  economico: ['equilibrado', 'premium'],
  equilibrado: ['premium', 'economico'],
  premium: ['equilibrado', 'economico']
};

const porPreco = (a, b) => (a.price_cents - b.price_cents) || String(a.name).localeCompare(String(b.name));

export const perfilDoCliente = (valor) => DO_CLIENTE[String(valor ?? '').toLowerCase()] ?? null;

/** Só entra quem está ativo e tem preço: a IA não pode citar um plano sem valor. */
export const oferecivel = (plano) => Boolean(plano?.active) && Number.isInteger(plano.price_cents) && plano.price_cents > 0;

/**
 * @param {Array<{name:string, profile:string, price_cents:number, active:boolean}>} planos
 * @param {string|null} perfil economico | equilibrado | qualidade | null
 * @returns {Array} de 0 a 2 planos
 */
export function escolherPlanos(planos, perfil) {
  const lista = (planos ?? []).filter(oferecivel).sort(porPreco);
  if (!lista.length) return [];
  const alvo = perfilDoCliente(perfil);
  const doPerfil = (nome) => lista.find((p) => p.profile === nome);

  let primeiro;
  if (alvo) {
    primeiro = doPerfil(alvo) ?? VIZINHO[alvo].map(doPerfil).find(Boolean) ?? lista[0];
  } else {
    primeiro = lista[0];
  }
  const ordem = alvo ? VIZINHO[alvo] : ['equilibrado', 'premium'];
  let segundo = ordem.map(doPerfil).find((p) => p && p !== primeiro);
  if (!segundo) segundo = lista.find((p) => p !== primeiro);
  return segundo ? [primeiro, segundo] : [primeiro];
}

/** "R$ 89,90" a partir de centavos. */
export const reais = (centavos) => `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`;

/** A linha que a ferramenta devolve ao modelo para um plano. */
export function descreverPlano(plano) {
  const partes = [plano.name];
  if (plano.speed_mbps) partes.push(`${plano.speed_mbps} Mega`);
  partes.push(`${reais(plano.price_cents)} por mês`);
  if (plano.includes) partes.push(`inclui: ${plano.includes}`);
  return partes.join(' — ');
}
