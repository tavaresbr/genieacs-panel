/**
 * O estado ao vivo de um ponto da Topologia com PPPoE, como o servidor
 * devolve em `GET /api/mapping-data/status`.
 */
export type LiveState = 'online' | 'weak' | 'offline' | 'unknown'

export interface LiveItem {
  node_id: string
  state: LiveState
  deviceId: string | null
  rxPower: number | null
  lastInform: string | null
}

export interface LiveStatus {
  generatedAt: string
  items: LiveItem[]
  summary: Record<LiveState, number>
}

export const LIVE_STATES: LiveState[] = ['online', 'weak', 'offline', 'unknown']

/** Verde, âmbar, vermelho e cinza — as cores de status do resto do painel. */
export const LIVE_COLORS: Record<LiveState, string> = {
  online: '#22c55e',
  weak: '#f59e0b',
  offline: '#ef4444',
  unknown: '#94a3b8'
}

export const liveLabelKey = (state: LiveState) => `map.live.state.${state}` as const

/** Quanto tempo entre uma releitura e outra enquanto o mapa está aberto. */
export const LIVE_REFRESH_MS = 60_000
