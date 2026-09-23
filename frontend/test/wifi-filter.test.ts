import { describe, expect, it } from 'vitest'

import { filterWifiByStatus, parseWifiStatusFilter } from '@/lib/wifi-filter'

const networks = [
  { index: 1, enable: true },
  { index: 2, enable: false },
  { index: 3, enable: null },
  { index: 4, enable: undefined },
]

describe('filterWifiByStatus', () => {
  const run = (filter: 'all' | 'enabled' | 'disabled') =>
    filterWifiByStatus(networks, filter, (n) => n.enable)

  it('conta ativas e trata estado desconhecido como desativada', () => {
    expect(run('all').counts).toEqual({ all: 4, enabled: 1, disabled: 3 })
  })

  it('mostra todas por padrão', () => {
    expect(run('all').visible.map((n) => n.index)).toEqual([1, 2, 3, 4])
  })

  it('mostra só as ativas', () => {
    expect(run('enabled').visible.map((n) => n.index)).toEqual([1])
  })

  it('mostra desativadas e desconhecidas', () => {
    expect(run('disabled').visible.map((n) => n.index)).toEqual([2, 3, 4])
  })
})

describe('parseWifiStatusFilter', () => {
  it('aceita as três opções', () => {
    expect(parseWifiStatusFilter('enabled')).toBe('enabled')
    expect(parseWifiStatusFilter('disabled')).toBe('disabled')
    expect(parseWifiStatusFilter('all')).toBe('all')
  })

  it('volta para "all" com valor ausente ou inválido', () => {
    expect(parseWifiStatusFilter(null)).toBe('all')
    expect(parseWifiStatusFilter(undefined)).toBe('all')
    expect(parseWifiStatusFilter('ativas')).toBe('all')
  })
})
