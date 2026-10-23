'use client'

import { useCallback, useEffect, useState } from 'react'
import { whatsappAPI, type WhatsAppMarketingOptOutConfig } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

/** Uma palavra por linha na tela; a API recebe a lista. */
const asLines = (words: string[]) => words.join('\n')
const asList = (text: string) => text.split('\n').map((word) => word.trim()).filter(Boolean)

/**
 * "Parar promoções": as palavras com que o cliente sai das promoções (e volta)
 * e o que o painel responde a ele. Fica ao lado da configuração do WhatsApp
 * porque vale para todos os números, por QR e oficiais.
 */
export function MarketingOptOutPanel() {
  const { t } = useTranslation()
  const toast = useToast()
  const [config, setConfig] = useState<WhatsAppMarketingOptOutConfig | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [stopWords, setStopWords] = useState('')
  const [resumeWords, setResumeWords] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [resumeText, setResumeText] = useState('')
  const [saving, setSaving] = useState(false)

  const apply = useCallback((next: WhatsAppMarketingOptOutConfig) => {
    setConfig(next)
    setEnabled(next.enabled)
    setStopWords(asLines(next.stopWords))
    setResumeWords(asLines(next.resumeWords))
    setConfirmText(next.confirmText)
    setResumeText(next.resumeText)
  }, [])

  useEffect(() => {
    void whatsappAPI.getMarketingOptOutConfig().then((res) => { if (res.success && res.data) apply(res.data) })
  }, [apply])

  const save = async () => {
    setSaving(true)
    try {
      const res = await whatsappAPI.updateMarketingOptOutConfig({
        enabled,
        stopWords: asList(stopWords),
        resumeWords: asList(resumeWords),
        confirmText,
        resumeText
      })
      if (!res.success || !res.data) {
        // A recusa da palavra repetida vem do servidor já com as palavras na frase.
        toast.error(res.message || t('settings.marketingOptOut.saveFailed'))
        return
      }
      apply(res.data)
      toast.success(t('settings.marketingOptOut.saved'))
    } finally {
      setSaving(false)
    }
  }

  const restoreDefaults = () => {
    if (!config) return
    setStopWords(asLines(config.defaults.stopWords))
    setResumeWords(asLines(config.defaults.resumeWords))
    setConfirmText(config.defaults.confirmText)
    setResumeText(config.defaults.resumeText)
  }

  return (
    <div className="modern-card mt-6 max-w-3xl p-5 sm:p-6" data-testid="marketing-opt-out-panel">
      <p className="page-kicker">{t('settings.marketingOptOut.kicker')}</p>
      <h2 className="section-heading">{t('settings.marketingOptOut.title')}</h2>
      <p className="section-description mb-6">{t('settings.marketingOptOut.description')}</p>

      {!config ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <div className="grid gap-4">
          <label className="flex items-start gap-3">
            <input type="checkbox" className="mt-1" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            <span className="text-sm">
              <span className="block font-semibold">{t('settings.marketingOptOut.enabled')}</span>
              <span className="text-muted-foreground">{t('settings.marketingOptOut.enabledHint')}</span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="field-label" htmlFor="mkt-stop-words">{t('settings.marketingOptOut.stopWords')}</label>
              <textarea
                id="mkt-stop-words"
                className="modern-input min-h-36 w-full font-mono text-sm"
                value={stopWords}
                onChange={(event) => setStopWords(event.target.value)}
              />
              <p className="field-hint">{t('settings.marketingOptOut.stopWordsHint')}</p>
            </div>
            <div>
              <label className="field-label" htmlFor="mkt-resume-words">{t('settings.marketingOptOut.resumeWords')}</label>
              <textarea
                id="mkt-resume-words"
                className="modern-input min-h-36 w-full font-mono text-sm"
                value={resumeWords}
                onChange={(event) => setResumeWords(event.target.value)}
              />
              <p className="field-hint">{t('settings.marketingOptOut.resumeWordsHint')}</p>
            </div>
          </div>

          <p className="field-hint">
            {t('settings.marketingOptOut.metaButtons', { labels: config.metaButtons.join(', ') })}
          </p>

          <div>
            <label className="field-label" htmlFor="mkt-confirm-text">{t('settings.marketingOptOut.confirmText')}</label>
            <textarea
              id="mkt-confirm-text"
              className="modern-input min-h-20 w-full"
              maxLength={500}
              value={confirmText}
              onChange={(event) => setConfirmText(event.target.value)}
            />
            <p className="field-hint">{t('settings.marketingOptOut.confirmTextHint')}</p>
          </div>
          <div>
            <label className="field-label" htmlFor="mkt-resume-text">{t('settings.marketingOptOut.resumeText')}</label>
            <textarea
              id="mkt-resume-text"
              className="modern-input min-h-20 w-full"
              maxLength={500}
              value={resumeText}
              onChange={(event) => setResumeText(event.target.value)}
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" className="modern-button" disabled={saving} onClick={() => void save()}>
              <Icon name="check" size={16} />
              {saving ? t('common.loading') : t('common.save')}
            </button>
            <button type="button" className="modern-button-secondary" disabled={saving} onClick={restoreDefaults}>
              <Icon name="refresh" size={16} />
              {t('settings.marketingOptOut.restoreDefaults')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
