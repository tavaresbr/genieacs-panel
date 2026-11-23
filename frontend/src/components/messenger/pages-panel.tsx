'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { messengerAPI, type MessengerFacebookPage, type MessengerPage } from '@/lib/api'
import { isPageId, messengerErrorKey, parseFacebookLoginMessage } from '@/lib/messenger'
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
export function MessengerPagesPanel({
  webhookPath,
  facebookAppId,
  onChanged
}: {
  webhookPath: string | null
  /** O app da Meta do login do Facebook; vazio quando a plataforma não o configurou. */
  facebookAppId?: string | null
  onChanged: () => void
}) {
  const { t, formatDateTime } = useTranslation()
  const toast = useToast()
  const { confirm, element: confirmElement } = useConfirm()
  const [pages, setPages] = useState<MessengerPage[] | null>(null)
  const [pageId, setPageId] = useState('')
  const [pageToken, setPageToken] = useState('')
  const [busy, setBusy] = useState(false)
  // O token do USUÁRIO que o popup entregou: vive só aqui, até a escolha da Página.
  const [facebookToken, setFacebookToken] = useState<string | null>(null)
  const [facebookPages, setFacebookPages] = useState<MessengerFacebookPage[] | null>(null)
  const popupRef = useRef<Window | null>(null)

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

  const loadFacebookPages = useCallback(
    async (accessToken: string) => {
      setBusy(true)
      try {
        const res = await messengerAPI.facebookPages(accessToken)
        if (res.success && res.data) {
          setFacebookToken(accessToken)
          setFacebookPages(res.data)
        } else {
          setFacebookToken(null)
          setFacebookPages(null)
          toast.error(t(messengerErrorKey(res.code)))
        }
      } finally {
        setBusy(false)
      }
    },
    [t, toast]
  )

  // O popup avisa por postMessage; só vale a mensagem da janela que abrimos.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const result = parseFacebookLoginMessage(event, popupRef.current, window.location.origin)
      if (!result) return
      popupRef.current = null
      if ('accessToken' in result) void loadFacebookPages(result.accessToken)
      else toast.error(t('messenger.pages.facebookCancelled'))
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [loadFacebookPages, t, toast])

  const handleFacebookLogin = () => {
    if (!facebookAppId) return
    const popup = window.open(
      `/messenger-connect.html?app=${encodeURIComponent(facebookAppId)}`,
      'messenger-facebook-login',
      'popup,width=520,height=640'
    )
    if (!popup) {
      toast.error(t('messenger.pages.facebookPopupBlocked'))
      return
    }
    popupRef.current = popup
  }

  const handleFacebookConnect = async (page: MessengerFacebookPage) => {
    if (!facebookToken) return
    setBusy(true)
    try {
      const res = await messengerAPI.facebookConnect(facebookToken, page.id)
      if (res.success && res.data) {
        if (res.data.status === 'error') {
          toast.error(t('messenger.pages.connectedWithError', { error: res.data.webhookError ?? '' }))
        } else {
          toast.success(t('messenger.pages.connected'))
        }
        setFacebookPages((list) => list?.map((p) => (p.id === page.id ? { ...p, connected: true } : p)) ?? null)
        await load()
        onChanged()
      } else {
        toast.error(t(messengerErrorKey(res.code)))
      }
    } finally {
      setBusy(false)
    }
  }

  const handleResubscribe = async (page: MessengerPage) => {
    setBusy(true)
    try {
      const res = await messengerAPI.resubscribePage(page.id)
      if (res.success && res.data) {
        if (res.data.status === 'error') {
          toast.error(t('messenger.pages.connectedWithError', { error: res.data.webhookError ?? '' }))
        } else {
          toast.success(t('messenger.pages.resubscribed'))
        }
        await load()
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
                  className="modern-button-secondary max-sm:min-h-10"
                  title={t('messenger.pages.resubscribeHint')}
                  disabled={busy}
                  onClick={() => void handleResubscribe(page)}
                >
                  {t('messenger.pages.resubscribe')}
                </button>
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

      {facebookAppId && (
        <div className="space-y-3">
          <button type="button" className="modern-button" disabled={busy} onClick={handleFacebookLogin}>
            {t('messenger.pages.facebookLogin')}
          </button>
          {facebookPages && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-foreground">{t('messenger.pages.facebookPick')}</p>
              {facebookPages.length === 0 && <p className="field-hint">{t('messenger.pages.facebookNone')}</p>}
              <ul className="divide-y divide-border rounded-md border border-border" role="list">
                {facebookPages.map((page) => (
                  <li key={page.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">{page.name || page.id}</p>
                      <p className="font-mono text-[0.72rem] text-muted-foreground">{page.id}</p>
                    </div>
                    {page.connected ? (
                      <span className="modern-badge">{t('messenger.pages.facebookAlready')}</span>
                    ) : (
                      <button
                        type="button"
                        className="modern-button-secondary max-sm:min-h-10"
                        disabled={busy}
                        onClick={() => void handleFacebookConnect(page)}
                      >
                        {t('messenger.pages.connect')}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {facebookAppId && <p className="text-sm font-medium text-foreground">{t('messenger.pages.manualTitle')}</p>}
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
