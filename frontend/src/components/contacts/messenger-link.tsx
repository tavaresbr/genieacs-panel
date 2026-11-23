'use client'

import { useState } from 'react'
import { messengerAPI, type ContactProfileContract } from '@/lib/api'
import { messengerErrorKey } from '@/lib/messenger'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

/**
 * O link do Messenger do assinante, para o atendente mandar (WhatsApp, e-mail,
 * fatura). Quando o assinante o abre, a conversa dele nasce vinculada a este
 * contrato — sem ninguém ter de procurar o cliente na caixa.
 *
 * O link vale uma vez e por uma semana, então cada clique em "Gerar" emite um
 * novo: o antigo continua valendo até vencer ou ser usado.
 */
export function MessengerLinkButton({ contracts }: { contracts: ContactProfileContract[] }) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const [chosen, setChosen] = useState(contracts[0]?.key ?? '')
  const [busy, setBusy] = useState(false)
  const [issued, setIssued] = useState<{ url: string; expiresAt: string } | null>(null)

  if (contracts.length === 0) return null

  const generate = async () => {
    setBusy(true)
    try {
      const res = await messengerAPI.createLink(chosen)
      if (res.success && res.data) setIssued(res.data)
      else toast.error(t(messengerErrorKey(res.code)))
    } finally {
      setBusy(false)
    }
  }

  const copy = async () => {
    if (!issued) return
    try {
      await navigator.clipboard.writeText(issued.url)
      toast.success(t('messenger.linkIssue.copied'))
    } catch {
      toast.error(t('messenger.linkIssue.copyFailed'))
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {contracts.length > 1 && (
        <select
          className="modern-input w-auto"
          value={chosen}
          aria-label={t('messenger.linkIssue.contract')}
          onChange={(event) => {
            setChosen(event.target.value)
            setIssued(null)
          }}
        >
          {contracts.map((contract) => (
            <option key={contract.key} value={contract.key}>{contract.contract}</option>
          ))}
        </select>
      )}
      <button type="button" className="modern-button-secondary" disabled={busy} onClick={() => void generate()}>
        <Icon name="chat" size={16} /> {busy ? t('messenger.linkIssue.generating') : t('messenger.linkIssue.button')}
      </button>
      {issued && (
        <div className="flex w-full flex-wrap items-center gap-2" data-testid="messenger-link-issued">
          <input className="modern-input min-w-0 flex-1 font-mono text-xs" readOnly value={issued.url} aria-label={t('messenger.linkIssue.button')} onFocus={(event) => event.currentTarget.select()} />
          <button type="button" className="modern-button-secondary" onClick={() => void copy()}>
            {t('messenger.linkIssue.copy')}
          </button>
          <p className="field-hint w-full">{t('messenger.linkIssue.hint', { date: formatDateTime(issued.expiresAt) })}</p>
        </div>
      )}
    </div>
  )
}
