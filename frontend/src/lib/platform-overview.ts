/**
 * As peças puras do console: a aba que está na URL (`?tab=`) e a leitura de
 * uma variação para o `StatTile`. Fora dos componentes para os testes
 * fixarem sem React.
 */

/** As abas do console, na ordem da faixa. `home` (Início) é a padrão. */
export const PLATFORM_TABS = [
  'home', 'tenants', 'plans', 'subscriptions', 'delinquency', 'revenue', 'coupons', 'leads',
  'admins', 'audit', 'settings', 'deployment', 'catalogue', 'help'
] as const

export type PlatformTab = (typeof PLATFORM_TABS)[number]

export const DEFAULT_PLATFORM_TAB: PlatformTab = 'home'

/** A aba de um valor de `?tab=`: o desconhecido (ou ausente) é a padrão. */
export function parsePlatformTab(valor: string | null | undefined): PlatformTab {
  const texto = (valor ?? '').trim()
  return (PLATFORM_TABS as readonly string[]).includes(texto) ? (texto as PlatformTab) : DEFAULT_PLATFORM_TAB
}

/**
 * A query com a aba trocada, mantendo os outros parâmetros. A padrão sai da
 * URL (o console sem `?tab=` já abre nela).
 */
export function withPlatformTab(search: string | URLSearchParams, tab: PlatformTab): URLSearchParams {
  const params = new URLSearchParams(search)
  if (tab === DEFAULT_PLATFORM_TAB) params.delete('tab')
  else params.set('tab', tab)
  return params
}

/**
 * O tom de uma variação: subir é bom, a não ser onde subir é ruim
 * (inadimplência, falhas). Sem variação, neutro.
 */
export function deltaTone(delta: number | null | undefined, upIsBad = false): 'good' | 'bad' | 'neutral' {
  if (delta === null || delta === undefined || delta === 0 || !Number.isFinite(delta)) return 'neutral'
  return (delta > 0) !== upIsBad ? 'good' : 'bad'
}

/**
 * O texto de uma variação, ou nulo quando não há (o tile mostra "sem
 * variação"): `+R$ 10,00 (+5%)`. `format` formata o valor absoluto.
 */
export function deltaText(
  delta: number | null | undefined,
  pct: number | null | undefined,
  format: (value: number) => string,
  locale: string
): string | null {
  if (delta === null || delta === undefined || delta === 0 || !Number.isFinite(delta)) return null
  const sinal = delta > 0 ? '+' : '-'
  let pctTexto = ''
  if (pct !== null && pct !== undefined && Number.isFinite(pct)) {
    let numero: string
    try {
      numero = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(Math.abs(pct))
    } catch {
      numero = `${(Math.abs(pct) * 100).toFixed(1)}%`
    }
    pctTexto = ` (${sinal}${numero})`
  }
  return `${sinal}${format(Math.abs(delta)).replace(/^[+-]/, '')}${pctTexto}`
}
