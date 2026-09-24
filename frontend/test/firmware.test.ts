import { describe, expect, it } from 'vitest'

import type { DeviceFirmwareFile } from '@/lib/api'
import { defaultFirmwareChoice, formatFileSize } from '@/lib/firmware'

const arquivo = (id: string, installed = false): DeviceFirmwareFile => ({
  id, version: id, oui: null, productClass: 'F670L', size: null, uploadedAt: null, installed
})

describe('o firmware que a tela já deixa marcado', () => {
  it('o mais novo que não é o instalado', () => {
    expect(defaultFirmwareChoice([arquivo('v3'), arquivo('v2', true), arquivo('v1')])).toBe('v3')
    expect(defaultFirmwareChoice([arquivo('v3', true), arquivo('v2'), arquivo('v1')])).toBe('v2')
  })

  it('nenhum, quando só sobra o instalado ou a lista está vazia', () => {
    expect(defaultFirmwareChoice([arquivo('v1', true)])).toBeNull()
    expect(defaultFirmwareChoice([])).toBeNull()
  })
})

describe('o tamanho do arquivo', () => {
  it('em unidades de 1024, com uma casa', () => {
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(2048)).toBe('2.0 KB')
    expect(formatFileSize(12_345_678)).toBe('11.8 MB')
    expect(formatFileSize(3 * 1024 ** 3)).toBe('3.0 GB')
  })

  it('sem número, não inventa zero', () => {
    expect(formatFileSize(null)).toBeNull()
    expect(formatFileSize(undefined)).toBeNull()
    expect(formatFileSize(Number.NaN)).toBeNull()
    expect(formatFileSize(-1)).toBeNull()
  })
})
