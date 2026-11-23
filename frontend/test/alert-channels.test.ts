import { describe, expect, it } from 'vitest'
import { canTestItem, channelCards, type AlertChannelsInfo } from '../src/lib/alert-channels'

const pronto: AlertChannelsInfo = {
  whatsapp: { configured: true, addon: true, numberConnected: true, recipients: 2 },
  email: { smtp: true, recipients: 1 },
  telegram: { configured: true, ready: true }
}
const por = (info: AlertChannelsInfo) => Object.fromEntries(channelCards(info).map((c) => [c.id, c]))

describe('channelCards', () => {
  it('tudo pronto: três pontos verdes, com a contagem de cada lista', () => {
    const cards = por(pronto)
    expect(cards.whatsapp).toMatchObject({ tone: 'ok', count: 2, hint: 'whatsapp.alerts.chWhatsappOk' })
    expect(cards.email).toMatchObject({ tone: 'ok', count: 1 })
    expect(cards.telegram).toMatchObject({ tone: 'ok', count: null })
  })

  it('WhatsApp diz o que falta, na ordem em que a varredura recusa', () => {
    expect(por({ ...pronto, whatsapp: { ...pronto.whatsapp, configured: false } }).whatsapp.hint).toBe('whatsapp.error.notConfigured')
    expect(por({ ...pronto, whatsapp: { ...pronto.whatsapp, addon: false } }).whatsapp.hint).toBe('whatsapp.alerts.chWhatsappNoAddon')
    expect(por({ ...pronto, whatsapp: { ...pronto.whatsapp, numberConnected: false } }).whatsapp).toMatchObject({ tone: 'warn', hint: 'whatsapp.alerts.noAlertNumber' })
    expect(por({ ...pronto, whatsapp: { ...pronto.whatsapp, recipients: 0 } }).whatsapp).toMatchObject({ tone: 'off', hint: 'whatsapp.alerts.chNoRecipients' })
  })

  it('e-mail sem SMTP avisa quando há endereço guardado e fica cinza quando não há', () => {
    expect(por({ ...pronto, email: { smtp: false, recipients: 1 } }).email).toMatchObject({ tone: 'warn', hint: 'whatsapp.alerts.mailNotConfigured' })
    expect(por({ ...pronto, email: { smtp: false, recipients: 0 } }).email.tone).toBe('off')
    expect(por({ ...pronto, email: { smtp: true, recipients: 0 } }).email).toMatchObject({ tone: 'off', hint: 'whatsapp.alerts.chNoRecipients' })
  })

  it('Telegram: sem bot é opcional; bot sem grupo é aviso', () => {
    expect(por({ ...pronto, telegram: { configured: false, ready: false } }).telegram).toMatchObject({ tone: 'off', hint: 'whatsapp.alerts.chTelegramNo' })
    expect(por({ ...pronto, telegram: { configured: true, ready: false } }).telegram).toMatchObject({ tone: 'warn', hint: 'whatsapp.alerts.chTelegramNoChat' })
  })
})

describe('canTestItem', () => {
  it('só o item já salvo pode ser testado', () => {
    expect(canTestItem(['5593981215425'], '5593981215425')).toBe(true)
    expect(canTestItem(['5593981215425'], '5593999990000')).toBe(false)
    expect(canTestItem([], 'a@b.co')).toBe(false)
  })
})
