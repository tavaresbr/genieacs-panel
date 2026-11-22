'use client'

import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { messengerAPI, type MessengerPage } from '@/lib/api'
import { isPageId, messengerErrorKey } from '@/lib/messenger'
import { useConfirm } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

/**
 * As Páginas do Facebook conectadas ao Messenger do provedor.
 *
 * O token da Página vai do campo direto para o servidor e não fica em estado
 * além do envio: o servidor confere na Meta, guarda cifrado e nunca o devolve,
 * então esta tela não tem o que mostrar de volta.
 */
export function MessengerPagesPanel({ webhookPath, onChanged }: { webhookPath: string | null; onChanged: () => void }) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const { confirm, element: confirmElement } = useConfirm()
  const [pages, setPages] = useState<MessengerPage[] | null>(null)
  const [pageId, setPageId] = useState('')
  const [pageToken, setPageToken] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await messengerAPI.listPages()
    if (res.success && res.data) setPages(res.data)
    else toast.error(t('messenger.pages.loadFailed'))
  }, [t, toast])

  useEffect(() => {
    void load()
  }, [load])

  const handleConnect = async (event: FormEvent) => {
    event.preventDefault()
    if (!isPageId(pageId)) {
      toast.error(t('messenger.error.invalidPageId'))
      return
    }
    if (!pageToken.trim()) {
      toast.error(t('messenger.error.missingToken'))
      return
    }
    setBusy(true)
    try {
      const res = await messengerAPI.connectPage(pageId.trim(), pageToken.trim())
      if (res.success && res.data) {
        if (res.data.status === 'error') {
          toast.error(t('messenger.pages.connectedWithError', { error: res.data.webhookError ?? '' }))
        } else {
          toast.success(t('messenger.pages.connected'))
        }
        setPageId('')
        setPageToken('')
        await load()
        onChanged()
      } else {
        toast.error(t(messengerErrorKey(res.code)))
      }
    } finally {
      setBusy(false)
    }
  }

  const handleDisconnect = async (page: MessengerPage) => {
    const name = page.pageName || page.pageId
    if (!(await confirm(t('messenger.pages.disconnectConfirm', { name }), { danger: true }))) return
    setBusy(true)
    try {
      const res = await messengerAPI.disconnectPage(page.id)
      if (res.success) {
        toast.success(t('messenger.pages.disconnected'))
        await load()
        onChanged()
      } else {
        toast.error(t(messengerErrorKey(res.code)))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="modern-card space-y-4 p-4" aria-labelledby="messenger-pages-title">
      <h2 id="messenger-pages-title" className="text-base font-semibold text-foreground">
        {t('messenger.pages.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('messenger.pages.hint')}</p>
      {webhookPath && (
        <p className="field-hint break-all">
          {t('messenger.pages.webhook', { url: `${window.location.origin}${webhookPath}` })}
        </p>
      )}

      {pages && pages.length === 0 && <p className="field-hint">{t('messenger.pages.none')}</p>}
      {pages && pages.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border" role="list">
          {pages.map((page) => (
            <li key={page.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{page.pageName || page.pageId}</p>
                <p className="font-mono text-[0.72rem] text-muted-foreground">{page.pageId}</p>
                {page.status === 'error' && page.webhookError && (
                  <p className="text-xs text-[hsl(var(--status-danger))]">{page.webhookError}</p>
                )}
                {page.subscribedAt && (
                  <p className="text-xs text-muted-foreground">{formatDateTime(page.subscribedAt)}</p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`modern-badge ${page.status === 'error' ? 'text-[hsl(var(--status-danger))]' : 'text-[hsl(var(--status-success))]'}`}
                  role="status"
                >
                  {t(page.status === 'error' ? 'messenger.pages.statusError' : 'messenger.pages.statusConnected')}
                </span>
                <button
                  type="button"
                  className="modern-button-danger max-sm:min-h-10"
                  disabled={busy}
                  onClick={() => void handleDisconnect(page)}
                >
                  {t('messenger.pages.disconnect')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={(event) => void handleConnect(event)} className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">{t('messenger.pages.pageId')}</span>
          <input
            className="modern-input"
            inputMode="numeric"
            autoComplete="off"
            value={pageId}
            onChange={(event) => setPageId(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="field-label">{t('messenger.pages.token')}</span>
          <input
            className="modern-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={pageToken}
            onChange={(event) => setPageToken(event.target.value)}
          />
        </label>
        <div className="sm:col-span-2">
          <button type="submit" className="modern-button" disabled={busy}>
            {busy ? t('messenger.pages.connecting') : t('messenger.pages.connect')}
          </button>
        </div>
      </form>
      {confirmElement}
    </section>
  )
}
