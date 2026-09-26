import { haversineMeters } from '@/lib/kml-import'

/**
 * Quem está ligado a uma caixa (CTO/ODP, CEO/ODC…) e quantas portas sobram.
 *
 * "Ligado" é ter um cabo desenhado entre a caixa e o ponto do cliente (ONT).
 * A capacidade vem do campo da caixa; sem ele, do splitter ("1x16" → 16).
 * Os clientes próximos sem cabo nenhum entram numa lista à parte: são os que
 * provavelmente saem desta caixa e ainda não foram desenhados — ou os
 * candidatos a uma instalação nova.
 */
export interface OccupancyNode {
  node_id: string
  type: string
  name: string
  latitude: number
  longitude: number
  capacity?: number | null
  splitter?: string | null
  pppoe?: string | null
}

export interface OccupancyEdge {
  source: string
  target: string
}

export interface BoxOccupancy<T extends OccupancyNode = OccupancyNode> {
  capacity: number | null
  used: number
  free: number | null
  over: boolean
  clients: T[]
  nearby: { node: T; distance: number }[]
}

/** Raio da lista "clientes próximos sem cabo". */
export const NEARBY_METERS = 200
const CLIENT_TYPES = new Set(['ont'])
export const BOX_TYPES = new Set(['odp', 'odc', 'htb'])

export function capacityOf(node: Pick<OccupancyNode, 'capacity' | 'splitter'>): number | null {
  if (typeof node.capacity === 'number' && Number.isInteger(node.capacity) && node.capacity > 0) return node.capacity
  const match = String(node.splitter ?? '').match(/1\s*[x:/]\s*(\d{1,3})/i)
  const fromSplitter = match ? Number(match[1]) : NaN
  return Number.isInteger(fromSplitter) && fromSplitter > 0 ? fromSplitter : null
}

const isClient = (node: OccupancyNode) => CLIENT_TYPES.has(node.type)

export function boxOccupancy<T extends OccupancyNode>(box: OccupancyNode, nodes: T[], edges: OccupancyEdge[]): BoxOccupancy<T> {
  const byId = new Map(nodes.map((node) => [node.node_id, node]))
  const linked = new Set<string>()
  const clientsWithCable = new Set<string>()
  for (const edge of edges) {
    const a = byId.get(edge.source)
    const b = byId.get(edge.target)
    if (!a || !b) continue
    if (isClient(a)) clientsWithCable.add(a.node_id)
    if (isClient(b)) clientsWithCable.add(b.node_id)
    if (edge.source === box.node_id && isClient(b)) linked.add(b.node_id)
    if (edge.target === box.node_id && isClient(a)) linked.add(a.node_id)
  }
  const clients = [...linked].map((id) => byId.get(id) as T).sort((x, y) => x.name.localeCompare(y.name))
  const capacity = capacityOf(box)
  const used = clients.length
  const nearby = nodes
    .filter((node) => isClient(node) && !clientsWithCable.has(node.node_id))
    .map((node) => ({ node, distance: Math.round(haversineMeters([box.latitude, box.longitude], [node.latitude, node.longitude])) }))
    .filter((entry) => entry.distance <= NEARBY_METERS)
    .sort((x, y) => x.distance - y.distance)
  return {
    capacity,
    used,
    free: capacity === null ? null : Math.max(capacity - used, 0),
    over: capacity !== null && used > capacity,
    clients,
    nearby
  }
}
