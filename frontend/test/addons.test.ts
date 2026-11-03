import { describe, expect, it } from 'vitest'

import {
  ADDON_STATE_KEYS, EMPTY_ADDON_FORM, addonAction, addonFormOf, addonPayloadFrom, addonState
} from '@/lib/addons'
import type { AddonView, TenantAddonRow } from '@/lib/api'
import en from '@/lib/i18n/locales/en'

const linha = (extra: Partial<TenantAddonRow> = {}): TenantAddonRow => ({
  id: 1, addonId: 1, code: 'whatsapp', name: 'WhatsApp', status: 'active', live: true, free: false,
  source: 'provider', reason: null, startedAt: '2026-10-01T00:00:00Z', cancelAt: null, canceledAt: null, ...extra
})

describe('o estado de um add-on na tela de Plano', () => {
  it('à venda, ativo, cancelando, de graça e fora da vitrine', () => {
    expect(addonState({ subscription: null, available: true })).toBe('available')
    expect(addonState({ subscription: null, available: false })).toBe('unavailable')
    expect(addonState({ subscription: linha(), available: false })).toBe('active')
    expect(addonState({ subscription: linha({ cancelAt: '2026-11-01T00:00:00Z' }), available: false })).toBe('cancelScheduled')
    expect(addonState({ subscription: linha({ free: true }), available: false })).toBe('free')
    expect(addonState({ subscription: linha({ status: 'canceled' }), available: true })).toBe('available')
  })

  it('o botão: ativar, cancelar na renovação, reativar antes dela — e nada no de graça', () => {
    expect(addonAction('available')).toBe('activate')
    expect(addonAction('active')).toBe('cancel')
    expect(addonAction('cancelScheduled')).toBe('reactivate')
    expect(addonAction('free')).toBeNull()
    expect(addonAction('unavailable')).toBeNull()
  })

  it('todo estado tem frase', () => {
    for (const chave of Object.values(ADDON_STATE_KEYS)) expect(en).toHaveProperty(chave)
  })
})

describe('o formulário do catálogo no console', () => {
  it('cria um add-on de recurso, com o preço anual opcional', () => {
    const lido = addonPayloadFrom({
      ...EMPTY_ADDON_FORM, code: 'WhatsApp', name: ' WhatsApp ', price: '49,90', feature: 'WhatsApp', gated: true
    })
    expect(lido).toEqual({
      payload: {
        code: 'whatsapp', kind: 'feature', feature: 'whatsapp', name: 'WhatsApp', description: null,
        priceCents: 4990, priceYearlyCents: null, gated: true, trialAccess: true, active: true, public: true, sort: 0
      }
    })
  })

  it('o de limite nunca fecha recurso, e pede a quantidade', () => {
    const lido = addonPayloadFrom({
      ...EMPTY_ADDON_FORM, code: 'ont-1000', name: '+1000 ONTs', price: '100', kind: 'limit', limitResource: 'devices', limitAmount: '1000', gated: true
    })
    expect('payload' in lido && lido.payload).toMatchObject({ kind: 'limit', limitResource: 'devices', limitAmount: 1000, gated: false })
    expect(addonPayloadFrom({ ...EMPTY_ADDON_FORM, code: 'x1', name: 'X', price: '1', kind: 'limit', limitAmount: '0' }))
      .toEqual({ error: 'platform.addons.form.invalidLimit' })
  })

  it('recusa o preço ilegível, o código fora do padrão e o recurso vazio', () => {
    expect(addonPayloadFrom({ ...EMPTY_ADDON_FORM, code: 'ok', name: 'X', price: '1.234' })).toEqual({ error: 'platform.addons.form.invalidPrice' })
    expect(addonPayloadFrom({ ...EMPTY_ADDON_FORM, code: 'a', name: 'X', price: '1' })).toEqual({ error: 'platform.addons.form.invalidCode' })
    expect(addonPayloadFrom({ ...EMPTY_ADDON_FORM, code: 'ok', name: 'X', price: '1' })).toEqual({ error: 'platform.addons.form.featureRequired' })
  })

  it('a edição manda só o que pode mudar, a partir do add-on do catálogo', () => {
    const addon: AddonView = {
      id: 3, code: 'ia', name: 'IA', description: null, priceCents: 2990, priceYearlyCents: 29900, currency: 'BRL',
      kind: 'feature', feature: 'ai', limitResource: null, limitAmount: null, gated: false, trialAccess: true,
      active: true, public: true, sort: 2
    }
    const form = addonFormOf(addon)
    expect(form.price).toBe('29,90')
    expect(form.priceYearly).toBe('299,00')
    const lido = addonPayloadFrom({ ...form, gated: true }, { editing: true })
    expect('payload' in lido && lido.payload).toEqual({
      name: 'IA', description: null, priceCents: 2990, priceYearlyCents: 29900, gated: true,
      trialAccess: true, active: true, public: true, sort: 2
    })
  })
})
