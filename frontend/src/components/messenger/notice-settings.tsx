'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { messengerAPI, type MessengerLinkedNotice } from '@/lib/api'
import { MESSENGER_NOTICE_MAX, messengerErrorKey } from '@/lib/messenger'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

/**
 * A confirmação que a pessoa lê no Messenger ao abrir um link de vínculo e ser
 * vinculada ao cadastro. É o provedor falando com o assinante, então ele pode
 * desligá-la e trocar o texto; vazio usa o texto de fábrica (mostrado abaixo).
 *
 * O texto não tem variáveis de propósito: o link não prova quem o abriu, e a
 * confirmação não pode entregar nome nem contrato a quem o recebeu repassado.
 */
export function MessengerNoticeSettings() {
  const { t } = useTranslation()
  const toast = useToast()
  const [notice, setNotice] = useState<MessengerLinkedNotice | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const res = await messengerAPI.getSettings()
    if (res.success && res.data) {
      setNotice(res.data.linkedNotice)
      setEnabled(res.data.linkedNotice.enabled)
      setText(res.data.linkedNotice.text)
    } else {
      toast.error(t('messenger.notice.loadFailed'))
    }
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = notice !== null && (enabled !== notice.enabled || text.trim() !== notice.text)

  const handleSave = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    try {
      const res = await messengerAPI.saveSettings({ enabled, text })
      if (res.success && res.data) {
        setNotice(res.data.linkedNotice)
        setText(res.data.linkedNotice.text)
        toast.success(t('messenger.notice.saved'))
      } else {
        toast.error(t(messengerErrorKey(res.code)))
      }
    } finally {
      setSaving(false)
    }
  }

  if (!notice) return null

  return (
    <section className="modern-card space-y-4 p-4" aria-labelledby="messenger-notice-title">
      <h2 id="messenger-notice-title" className="text-base font-semibold text-foreground">
        {t('messenger.notice.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('messenger.notice.hint')}</p>
      <form onSubmit={(event) => void handleSave(event)} className="space-y-3">
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          {t('messenger.notice.enabled')}
        </label>
        <label className="block">
          <span className="field-label">{t('messenger.notice.text')}</span>
          <textarea
            className="modern-input min-h-24"
            rows={4}
            maxLength={MESSENGER_NOTICE_MAX}
            disabled={!enabled}
            placeholder={notice.defaultText}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <span className="field-hint">
            {t('messenger.notice.textHint', { count: text.length, max: MESSENGER_NOTICE_MAX })}
          </span>
        </label>
        <p className="field-hint">{t('messenger.notice.defaultLabel', { text: notice.defaultText })}</p>
        <button type="submit" className="modern-button" disabled={saving || !dirty}>
          {saving ? t('messenger.notice.saving') : t('messenger.notice.save')}
        </button>
      </form>
    </section>
  )
}
