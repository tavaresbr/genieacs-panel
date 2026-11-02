/**
 * As peças puras da pesquisa de satisfação dos provedores (NPS, 0123): a
 * página pública e a seção "Satisfação" do console. Fora dos componentes para
 * os testes fixarem sem React.
 */

/** As notas, na ordem dos botões. */
export const NPS_SCORES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const

export type NpsCategory = 'promoter' | 'passive' | 'detractor'

/** Promotor (9–10), neutro (7–8) ou detrator (0–6) — a mesma régua do backend. */
export function npsCategory(score: number): NpsCategory {
  if (score >= 9) return 'promoter'
  if (score >= 7) return 'passive'
  return 'detractor'
}

/** O tom do número do NPS: acima de 30 é bom, abaixo de zero é ruim. */
export function npsTone(nps: number | null | undefined): 'good' | 'bad' | 'neutral' {
  if (nps === null || nps === undefined || !Number.isFinite(nps)) return 'neutral'
  if (nps >= 30) return 'good'
  if (nps < 0) return 'bad'
  return 'neutral'
}

/** O NPS escrito com sinal (`+42`, `-10`, `0`), ou travessão sem resposta. */
export function formatNps(nps: number | null | undefined): string {
  if (nps === null || nps === undefined || !Number.isFinite(nps)) return '—'
  return nps > 0 ? `+${nps}` : String(nps)
}

/**
 * O token da página pública, que vem no FRAGMENTO (`/nps#token`) — a parte do
 * endereço que o navegador não manda ao servidor. Só o alfabeto do base64url;
 * qualquer outra coisa é nulo e a página diz que o link não vale.
 */
export function readNpsToken(hash: string | null | undefined): string | null {
  const texto = String(hash ?? '').replace(/^#/, '').trim()
  return /^[A-Za-z0-9_-]{32,128}$/.test(texto) ? texto : null
}

/** O link do console para a assinatura de um provedor: a aba Assinaturas já filtrada por ele. */
export function subscriptionHref(tenant: { slug: string | null; name: string | null; id: number }): string {
  const busca = tenant.slug || tenant.name || String(tenant.id)
  return `/platform?tab=subscriptions&q=${encodeURIComponent(busca)}`
}

/** A maior barra da distribuição (para a escala), ao menos 1. */
export function distributionMax(distribution: readonly number[]): number {
  return Math.max(1, ...distribution.map((n) => (Number.isFinite(n) ? n : 0)))
}
