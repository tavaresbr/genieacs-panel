import type { SgpSplitter } from '@/lib/api'

/** Straight-line distance in metres between two coordinates (haversine). */
export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (value: number) => (value * Math.PI) / 180
  const dLat = rad(bLat - aLat)
  const dLng = rad(bLng - aLng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** "120 m", "1,4 km". */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(1).replace('.', ',')} km`
}

/**
 * The splitters the operator picks from: nearest first when both the client's
 * address and the splitter have coordinates, alphabetical otherwise (the ones
 * without a position after the ones with).
 */
export function sortSplitters(
  splitters: SgpSplitter[],
  lat?: number,
  lng?: number
): (SgpSplitter & { distance: number | null })[] {
  const hasOrigin = typeof lat === 'number' && typeof lng === 'number'
  return splitters
    .map((splitter) => ({
      ...splitter,
      distance: hasOrigin && typeof splitter.lat === 'number' && typeof splitter.lng === 'number'
        ? distanceMeters(lat, lng, splitter.lat, splitter.lng)
        : null
    }))
    .sort((a, b) => {
      if (a.distance !== null && b.distance !== null) return a.distance - b.distance
      if (a.distance !== null) return -1
      if (b.distance !== null) return 1
      return a.label.localeCompare(b.label, 'pt-BR', { numeric: true })
    })
}
