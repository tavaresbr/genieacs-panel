'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { whatsappAPI, type WhatsAppAccount } from '@/lib/api'
import { accountColor, accountName, WA_ACCOUNT_CLASS } from '@/lib/wa-account-color'

/**
 * Os números do provedor que podem iniciar conversa (só os conectados), o
 * padrão primeiro: o de propósito "general", depois o padrão da instalação,
 * depois o de menor id — a mesma regra que o servidor usa sem escolha.
 */
export function pickableAccounts(accounts: readonly WhatsAppAccount[]): WhatsAppAccount[] {
  const conectados = accounts.filter((a) => a.status === 'connected')
  const ordem = (a: WhatsAppAccount) => (a.purpose === 'general' ? 0 : a.isDefault ? 1 : 2)
  return [...conectados].sort((a, b) => ordem(a) - ordem(b) || a.id - b.id)
}

/** Os números conectados, lidos uma vez ao abrir a tela. Vazio enquanto carrega ou se falhar: o botão segue como sempre foi. */
export function useConnectedAccounts(enabled: boolean): WhatsAppAccount[] {
  const [accounts, setAccounts] = useState<WhatsAppAccount[]>([])
  useEffect(() => {
    if (!enabled) return
    let vivo = true
    void whatsappAPI.listAccounts().then((res) => {
      if (vivo && res.success && Array.isArray(res.data)) setAccounts(pickableAccounts(res.data))
    }).catch(() => {})
    return () => { vivo = false }
  }, [enabled])
  return accounts
}

interface ChatNumberMenuProps {
  /** Os números conectados (`useConnectedAccounts`). Com 0 ou 1, não há o que escolher. */
  accounts: readonly WhatsAppAccount[]
  /** `undefined` = sem escolha (um número só): o servidor usa o padrão. */
  onChoose: (accountId?: number) => void
  /** O botão: `onClick` é o que ele deve chamar. */
  children: (props: { onClick: () => void; expanded: boolean }) => ReactNode
}

/**
 * Envolve o botão "Conversar". Com mais de um número conectado, o clique abre
 * um menu pequeno "Conversar por qual número?"; com um só (ou nenhum), segue
 * direto, como sempre foi.
 */
export function ChatNumberMenu({ accounts, onChoose, children }: ChatNumberMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const first = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) first.current?.focus()
  }, [open])

  const choose = accounts.length > 1
  return (
    <span
      className="relative inline-flex"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false)
      }}
    >
      {children({
        expanded: open,
        onClick: () => {
          if (choose) setOpen((v) => !v)
          else onChoose(undefined)
        }
      })}
      {choose && open && (
        <div role="menu" aria-label={t('whatsapp.chatNumber.title')} className="absolute start-0 top-full z-30 mt-1 w-64 rounded-lg border border-border bg-card p-1 shadow-lg">
          <p className="px-3 py-1.5 text-xs text-muted-foreground">{t('whatsapp.chatNumber.title')}</p>
          {accounts.map((account, i) => (
            <button
              key={account.id}
              ref={i === 0 ? first : undefined}
              type="button"
              role="menuitem"
              className={`${WA_ACCOUNT_CLASS[accountColor(account)]} flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm hover:bg-[hsl(var(--surface-subtle))] focus-visible:bg-[hsl(var(--surface-subtle))]`}
              onClick={() => {
                setOpen(false)
                onChoose(account.id)
              }}
            >
              <span className="size-2 shrink-0 rounded-full bg-[hsl(var(--wa-account))]" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{accountName(account)}</span>
              {i === 0 && <span className="shrink-0 text-xs text-muted-foreground">{t('whatsapp.chatNumber.default')}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
