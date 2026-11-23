import { describe, expect, it } from 'vitest'
import { telegramChatErrorKey, telegramChatTitle } from '@/lib/telegram-chat'

describe('o título da conversa do Telegram', () => {
  const base = { name: null, username: null, chatId: '1234567890', clientName: null }

  it('prefere o cliente vinculado, depois o nome do Telegram, depois o @usuário', () => {
    expect(telegramChatTitle({ ...base, clientName: 'Maria Silva', name: 'maria', username: 'm' })).toBe('Maria Silva')
    expect(telegramChatTitle({ ...base, name: 'Maria S.', username: 'm' })).toBe('Maria S.')
    expect(telegramChatTitle({ ...base, username: 'maria_s' })).toBe('@maria_s')
  })

  it('sem nada, mostra só o fim do id do chat', () => {
    expect(telegramChatTitle(base)).toBe('…567890')
  })

  it('ignora nome em branco', () => {
    expect(telegramChatTitle({ ...base, name: '   ', username: 'x' })).toBe('@x')
  })
})

describe('os códigos de erro do canal de clientes', () => {
  it('cada código do servidor tem frase própria; o desconhecido cai na genérica', () => {
    expect(telegramChatErrorKey('chat_blocked')).toBe('telegramChat.error.chatBlocked')
    expect(telegramChatErrorKey('bot_unavailable')).toBe('telegramChat.error.botOff')
    expect(telegramChatErrorKey('no_bot')).toBe('telegramChat.error.botOff')
    expect(telegramChatErrorKey('invalid_token')).toBe('telegramChat.error.invalidToken')
    expect(telegramChatErrorKey('send_refused')).toBe('telegramChat.error.sendRefused')
    expect(telegramChatErrorKey('algo_novo')).toBe('messenger.error.generic')
    expect(telegramChatErrorKey(undefined)).toBe('messenger.error.generic')
  })
})
