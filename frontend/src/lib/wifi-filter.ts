export type WifiStatusFilter = 'all' | 'enabled' | 'disabled'

const FILTERS: readonly WifiStatusFilter[] = ['all', 'enabled', 'disabled']

/**
 * Lê o valor salvo no navegador. Qualquer coisa fora das três opções (chave
 * ausente, valor antigo, lixo) volta para "todas" — nunca esconde redes por
 * engano.
 */
export function parseWifiStatusFilter(value: string | null | undefined): WifiStatusFilter {
  return FILTERS.includes(value as WifiStatusFilter) ? (value as WifiStatusFilter) : 'all'
}

/**
 * Separa as redes por estado. "Estado desconhecido" (`null`/`undefined`) conta
 * como desativada: só é ativa a rede que o CPE confirmou estar transmitindo.
 */
export function filterWifiByStatus<T>(
  networks: readonly T[],
  filter: WifiStatusFilter,
  isEnabled: (network: T) => boolean | null | undefined
) {
  const enabledCount = networks.filter((network) => isEnabled(network) === true).length
  const visible = filter === 'all'
    ? [...networks]
    : networks.filter((network) => (isEnabled(network) === true) === (filter === 'enabled'))
  return {
    visible,
    counts: { all: networks.length, enabled: enabledCount, disabled: networks.length - enabledCount }
  }
}
