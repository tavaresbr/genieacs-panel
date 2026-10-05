import { describe, expect, it } from 'vitest'
import { latestPerConversation, shouldNotify, type NotificationItem } from '../src/lib/wa-notify'

const item = (messageId: number, conversationId: number): NotificationItem => ({
  messageId, conversationId, contact: 'X', preview: 'oi', hasAttachment: false, createdAt: '2026-10-05T12:00:00Z', mine: true
})

describe('notificações', () => {
  it('não avisa da conversa aberta com a aba à vista', () => {
    expect(shouldNotify(item(1, 7), { focusedConversationId: 7, visible: true })).toBe(false)
    expect(shouldNotify(item(1, 7), { focusedConversationId: 7, visible: false })).toBe(true)
    expect(shouldNotify(item(1, 7), { focusedConversationId: 8, visible: true })).toBe(true)
  })

  it('uma por conversa, a mais nova', () => {
    const r = latestPerConversation([item(1, 7), item(3, 7), item(2, 9)])
    expect(r.map((i) => i.messageId).sort()).toEqual([2, 3])
  })
})
