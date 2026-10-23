import { describe, expect, it } from 'vitest'

import en from '@/lib/i18n/locales/en'
import ptBR from '@/lib/i18n/locales/pt-BR'
import {
  QUALITY_LABEL, healthError, healthNeedsAttention, isDegradedStatus, messagingLimit, qualityTone
} from '@/lib/meta-health'

/**
 * A saúde do número oficial na Meta, como o cartão a mostra.
 *
 * O que se defende: a bolinha só tem as três cores da Meta (o resto é "sem
 * nota"), o limite vira texto de gente e um degrau desconhecido sai como veio,
 * a faixa de aviso aparece só com nota baixa ou sanção, e o erro gravado é
 * frase do painel quando é do painel.
 */
describe('qualityTone', () => {
  it('mapeia as três notas e cai em unknown no resto', () => {
    expect(qualityTone('GREEN')).toBe('green')
    expect(qualityTone('yellow')).toBe('yellow')
    expect(qualityTone('RED')).toBe('red')
    expect(qualityTone('UNKNOWN')).toBe('unknown')
    expect(qualityTone(null)).toBe('unknown')
  })

  it('cada tom tem frase nos dicionários', () => {
    for (const key of Object.values(QUALITY_LABEL)) {
      expect(en[key]).toBeTruthy()
      expect(ptBR[key]).toBeTruthy()
    }
  })
})

describe('messagingLimit', () => {
  it('traduz os degraus da Meta em número', () => {
    expect(messagingLimit('TIER_250')).toEqual({ kind: 'count', count: 250 })
    expect(messagingLimit('TIER_1K')).toEqual({ kind: 'count', count: 1000 })
    expect(messagingLimit('TIER_100K')).toEqual({ kind: 'count', count: 100000 })
    expect(messagingLimit('TIER_UNLIMITED')).toEqual({ kind: 'unlimited' })
  })

  it('degrau novo sai como veio, e vazio é nada', () => {
    expect(messagingLimit('TIER_5M')).toEqual({ kind: 'raw', text: 'TIER_5M' })
    expect(messagingLimit(null)).toBeNull()
    expect(messagingLimit('')).toBeNull()
  })
})

describe('healthNeedsAttention', () => {
  it('só com nota amarela ou vermelha, ou número sob sanção', () => {
    expect(healthNeedsAttention({ metaQualityRating: 'GREEN', metaNumberStatus: 'CONNECTED' })).toBe(false)
    expect(healthNeedsAttention({ metaQualityRating: 'UNKNOWN', metaNumberStatus: null })).toBe(false)
    expect(healthNeedsAttention({ metaQualityRating: 'YELLOW', metaNumberStatus: 'CONNECTED' })).toBe(true)
    expect(healthNeedsAttention({ metaQualityRating: 'GREEN', metaNumberStatus: 'RESTRICTED' })).toBe(true)
    expect(isDegradedStatus('flagged')).toBe(true)
  })
})

describe('healthError', () => {
  it('erro do painel vira chave; erro da Meta sai como texto', () => {
    expect(healthError('meta_unreachable')).toEqual({ key: 'whatsapp.cloud.webhookUnreachable', text: null })
    expect(healthError('(190) Invalid OAuth access token')).toEqual({ key: null, text: '(190) Invalid OAuth access token' })
    expect(healthError(null)).toBeNull()
  })
})
