import { describe, expect, it } from 'vitest'
import {
  MESSENGER_REPLY_WINDOW_MS,
  isPageId,
  messengerErrorKey,
  messengerTitle,
  remainingParts,
  MESSENGER_MAX_ATTEMPTS,
  deliveryLabel,
  hasPendingMessages,
  previewContent,
  sameLocalDay,
  windowRemainingMs,
  parseFacebookLoginMessage,
  canRetryMessage,
  isInlineImageMime,
} from '@/lib/messenger'

const NOW = Date.parse('2026-11-22T12:00:00Z')

describe('a janela de resposta do Messenger', () => {
  it('conta 24 h a partir da última mensagem da pessoa', () => {
    const lastInbound = new Date(NOW - 2 * 3600_000).toISOString()
    expect(windowRemainingMs(lastInbound, NOW)).toBe(MESSENGER_REPLY_WINDOW_MS - 2 * 3600_000)
  })

  it('fechada depois de 24 h, e nunca negativa', () => {
    expect(windowRemainingMs(new Date(NOW - 25 * 3600_000).toISOString(), NOW)).toBe(0)
  })

  it('sem mensagem da pessoa, ou com data ilegível, está fechada', () => {
    expect(windowRemainingMs(null, NOW)).toBe(0)
    expect(windowRemainingMs(undefined, NOW)).toBe(0)
    expect(windowRemainingMs('ontem', NOW)).toBe(0)
  })

  it('separa horas e minutos', () => {
    expect(remainingParts(5 * 3600_000 + 30 * 60_000 + 59_000)).toEqual({ hours: 5, minutes: 30 })
    expect(remainingParts(-1)).toEqual({ hours: 0, minutes: 0 })
  })
})

describe('o título e a prévia da conversa', () => {
  it('usa o nome, ou o fim do PSID quando não há', () => {
    expect(messengerTitle({ name: ' Maria ', psid: '1234567890' })).toBe('Maria')
    expect(messengerTitle({ name: null, psid: '1234567890' })).toBe('…567890')
    expect(messengerTitle({ name: '   ', psid: '1234567890' })).toBe('…567890')
  })

  it('o cliente vinculado vence o nome do Messenger', () => {
    expect(messengerTitle({ name: 'maria fb', clientName: 'Maria da Silva', psid: '1234567890' })).toBe('Maria da Silva')
    expect(messengerTitle({ name: 'maria fb', clientName: null, psid: '1234567890' })).toBe('maria fb')
    expect(messengerTitle({ name: null, clientName: '  ', psid: '1234567890' })).toBe('…567890')
  })

})

describe('a prévia da última mensagem', () => {
  it('mostra o texto; sem texto, o tipo do anexo; sem nada, vazio', () => {
    expect(previewContent({ text: 'Oi', attachmentType: null })).toEqual({ kind: 'text', text: 'Oi' })
    expect(previewContent({ text: 'Oi', attachmentType: 'image' })).toEqual({ kind: 'text', text: 'Oi' })
    expect(previewContent({ text: null, attachmentType: 'image' })).toEqual({ kind: 'attachment', type: 'image' })
    expect(previewContent({ text: '', attachmentType: null })).toEqual({ kind: 'empty' })
  })

  it('a lista mostra a hora de hoje e a data do resto', () => {
    const now = new Date(2026, 10, 23, 15, 0, 0)
    expect(sameLocalDay(new Date(2026, 10, 23, 1, 0, 0), now)).toBe(true)
    expect(sameLocalDay(new Date(2026, 10, 22, 23, 59, 0), now)).toBe(false)
    expect(sameLocalDay(new Date(2025, 10, 23, 15, 0, 0), now)).toBe(false)
    expect(sameLocalDay('não é data', now)).toBe(false)
  })
})

describe('os códigos de erro do servidor', () => {
  it('cada código conhecido tem a própria mensagem', () => {
    expect(messengerErrorKey('window_closed')).toBe('messenger.error.windowClosed')
    expect(messengerErrorKey('page_already_connected')).toBe('messenger.error.pageAlreadyConnected')
    expect(messengerErrorKey('messenger_unconfigured')).toBe('messenger.error.unconfigured')
    expect(messengerErrorKey('subscriber_not_found')).toBe('messenger.error.subscriberNotFound')
    expect(messengerErrorKey('notice_too_long')).toBe('messenger.error.noticeTooLong')
    expect(messengerErrorKey('send_refused')).toBe('messenger.error.sendRefused')
  })

  it('código desconhecido ou ausente cai na genérica, sem repetir texto cru', () => {
    expect(messengerErrorKey('algo_novo')).toBe('messenger.error.generic')
    expect(messengerErrorKey(undefined)).toBe('messenger.error.generic')
  })

  it('confere o id da Página como o servidor: só dígitos', () => {
    expect(isPageId('1000000001')).toBe(true)
    expect(isPageId(' 1000000001 ')).toBe(true)
    expect(isPageId('abc')).toBe(false)
    expect(isPageId('123')).toBe(false)
  })
})

describe('a fila de saída na conversa', () => {
  it('só as respostas ainda a caminho pedem a atualização mais rápida', () => {
    expect(hasPendingMessages([{ direction: 'out', deliveryStatus: 'queued' }])).toBe(true)
    expect(hasPendingMessages([{ direction: 'out', deliveryStatus: 'sending' }])).toBe(true)
    expect(hasPendingMessages([
      { direction: 'out', deliveryStatus: 'sent' },
      { direction: 'out', deliveryStatus: 'failed' },
      { direction: 'in', deliveryStatus: null },
    ])).toBe(false)
    expect(hasPendingMessages([])).toBe(false)
  })

  it('a que já falhou e espera na fila mostra a tentativa; o resto, o próprio estado', () => {
    expect(deliveryLabel({ deliveryStatus: 'queued', attempts: 2 })).toEqual({ kind: 'retrying', attempt: 2, max: MESSENGER_MAX_ATTEMPTS })
    expect(deliveryLabel({ deliveryStatus: 'queued', attempts: 0 })).toEqual({ kind: 'status', status: 'queued' })
    expect(deliveryLabel({ deliveryStatus: 'failed', attempts: 7 })).toEqual({ kind: 'status', status: 'failed' })
    expect(deliveryLabel({ deliveryStatus: null, attempts: 0 })).toBeNull()
  })
})

describe('parseFacebookLoginMessage', () => {
  const popup = {}
  const origin = 'https://painel.exemplo.com.br'
  const good = { type: 'messenger-fb-login', accessToken: 'EAAB' }

  it('aceita o token da janela que o painel abriu, na própria origem', () => {
    expect(parseFacebookLoginMessage({ origin, source: popup, data: good }, popup, origin)).toEqual({ accessToken: 'EAAB' })
  })

  it('devolve o cancelamento', () => {
    expect(
      parseFacebookLoginMessage({ origin, source: popup, data: { type: 'messenger-fb-login', error: 'cancelled' } }, popup, origin)
    ).toEqual({ error: 'cancelled' })
  })

  it('ignora outra origem, outra janela e outro tipo de mensagem', () => {
    expect(parseFacebookLoginMessage({ origin: 'https://evil.example', source: popup, data: good }, popup, origin)).toBeNull()
    expect(parseFacebookLoginMessage({ origin, source: {}, data: good }, popup, origin)).toBeNull()
    expect(parseFacebookLoginMessage({ origin, source: popup, data: { type: 'x', accessToken: 'a' } }, popup, origin)).toBeNull()
    expect(parseFacebookLoginMessage({ origin, source: popup, data: 'texto' }, popup, origin)).toBeNull()
    expect(parseFacebookLoginMessage({ origin, source: popup, data: good }, null, origin)).toBeNull()
  })
})

describe('canRetryMessage', () => {
  const failed = { direction: 'out' as const, deliveryStatus: 'failed' as const }
  it('só oferece reenviar a saída falhada, com a janela aberta e permissão de enviar', () => {
    expect(canRetryMessage(failed, true, true)).toBe(true)
    expect(canRetryMessage(failed, false, true)).toBe(false)
    expect(canRetryMessage(failed, true, false)).toBe(false)
    expect(canRetryMessage({ ...failed, deliveryStatus: 'sent' }, true, true)).toBe(false)
    expect(canRetryMessage({ ...failed, deliveryStatus: 'queued' }, true, true)).toBe(false)
    expect(canRetryMessage({ ...failed, direction: 'in' }, true, true)).toBe(false)
  })
})

describe('isInlineImageMime', () => {
  it('só imagem conhecida aparece na bolha; SVG e o resto são download', () => {
    for (const ok of ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'IMAGE/PNG']) expect(isInlineImageMime(ok)).toBe(true)
    for (const no of ['image/svg+xml', 'text/html', 'application/pdf', 'application/octet-stream', '', null, undefined]) {
      expect(isInlineImageMime(no)).toBe(false)
    }
  })
})
