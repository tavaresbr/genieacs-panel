import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { AcsHealth } from '@/lib/api'
import { loadDictionary, translate } from '@/lib/i18n'
import {
  ACS_DOWN_GRACE_MS, acsCodeLabelKey, acsDownSignature, acsReasonKey, shouldShowAcsBanner
} from '@/lib/acs-health'
import { ACS_SETTINGS_HREF, AcsHealthBannerView } from '@/components/acs-health-banner'
import { ACS_DOWN_DISMISSED_KEY, clearSessionScopedStorage } from '@/lib/session-owner'

/**
 * A faixa "o GenieACS não está acessível" da casca do painel.
 *
 * Ambiente `node`, sem DOM: a decisão de mostrar mora em
 * `shouldShowAcsBanner`, e a faixa em si é desenhada como HTML estático.
 */
const fora = (patch: Partial<AcsHealth> = {}): AcsHealth => ({
  status: 'down',
  code: 'dns',
  since: '2026-11-18T09:46:00.000Z',
  lastCheckedAt: '2026-11-18T09:50:00.000Z',
  consecutiveFailures: 12,
  downForMs: 4 * 60_000,
  ...patch
})

const ok: AcsHealth = {
  status: 'ok', code: null, since: '2026-11-18T09:00:00.000Z', lastCheckedAt: '2026-11-18T09:50:00.000Z', consecutiveFailures: 0, downForMs: 0
}

describe('quando a faixa aparece', () => {
  it('fora há mais de um minuto: aparece', () => {
    expect(shouldShowAcsBanner(fora(), '')).toBe(true)
  })

  it('fora há menos de um minuto, ou sem leitura ainda: não aparece', () => {
    expect(shouldShowAcsBanner(fora({ downForMs: ACS_DOWN_GRACE_MS - 1 }), '')).toBe(false)
    expect(shouldShowAcsBanner(fora({ downForMs: ACS_DOWN_GRACE_MS }), '')).toBe(false)
    expect(shouldShowAcsBanner(null, '')).toBe(false)
  })

  it('o ACS voltou: some', () => {
    expect(shouldShowAcsBanner(ok, '')).toBe(false)
  })

  it('fechada nesta aba: some para esta queda, e volta para outra', () => {
    const fechada = acsDownSignature(fora())
    expect(shouldShowAcsBanner(fora(), fechada)).toBe(false)
    // Outro motivo.
    expect(shouldShowAcsBanner(fora({ code: 'refused' }), fechada)).toBe(true)
    // O ACS voltou e caiu de novo: outro `since`.
    expect(shouldShowAcsBanner(fora({ since: '2026-11-18T11:00:00.000Z' }), fechada)).toBe(true)
  })

  it('o fechamento é da sessão: trocar de sessão o apaga', () => {
    const dados = new Map<string, string>([[ACS_DOWN_DISMISSED_KEY, 'dns|x']])
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => dados.get(k) ?? null,
      setItem: (k: string, v: string) => { dados.set(k, v) },
      removeItem: (k: string) => { dados.delete(k) }
    })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 })
    try {
      clearSessionScopedStorage()
      expect(dados.has(ACS_DOWN_DISMISSED_KEY)).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('o que a faixa diz', () => {
  const desenhar = (settingsHref: string | null) => renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(AcsHealthBannerView, {
      reason: translate('pt-BR', acsReasonKey('dns')),
      consequence: translate('pt-BR', 'acsHealth.consequence'),
      dismissLabel: translate('pt-BR', 'acsHealth.dismiss'),
      settingsLabel: translate('pt-BR', 'acsHealth.openSettings'),
      settingsHref
    }))
  )

  it('o motivo e a consequência, no idioma de quem olha', () => {
    expect(`${translate('pt-BR', acsReasonKey('dns'))} ${translate('pt-BR', 'acsHealth.consequence')}`).toBe(
      'O GenieACS não está acessível: o endereço configurado não existe no DNS. Os equipamentos não vão carregar até isso ser corrigido.'
    )
    const html = desenhar(null)
    expect(html).toContain('role="alert"')
    expect(html).toContain('o endereço configurado não existe no DNS')
    expect(html).toContain('Os equipamentos não vão carregar')
  })

  it('o administrador ganha o atalho para as configurações; os outros, só o texto', () => {
    expect(desenhar(ACS_SETTINGS_HREF)).toContain(`href="${ACS_SETTINGS_HREF.replace(/&/g, '&amp;')}"`)
    expect(desenhar(null)).not.toContain('href=')
  })

  it('cada código tem frase e rótulo em todo idioma, e código desconhecido cai em `unknown`', () => {
    for (const code of ['dns', 'refused', 'timeout', 'tls', 'unauthorized', 'http_error', 'blocked', 'unknown']) {
      expect(translate('en', acsReasonKey(code))).not.toBe(acsReasonKey(code))
      expect(translate('pt-BR', acsCodeLabelKey(code))).not.toBe(acsCodeLabelKey(code))
    }
    expect(acsReasonKey('algo-novo')).toBe('acsHealth.reason.unknown')
  })
})

beforeAll(async () => {
  await Promise.all([loadDictionary('en'), loadDictionary('pt-BR')])
})
afterEach(() => { vi.unstubAllGlobals() })
