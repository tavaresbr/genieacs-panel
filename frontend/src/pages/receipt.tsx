'use client'

import { useEffect, useRef, useState } from 'react'
import { receiptAPI } from '@/lib/api'
import { BrandMark } from '@/components/brand-mark'
import { useTranslation } from '@/contexts/language-context'
import { readReceiptToken } from '@/lib/receipt-link'

/**
 * O recibo de pagamento aberto pelo link que o bot do WhatsApp da plataforma
 * manda ao dono do provedor (`/receipt#<token>`).
 *
 * Sem sessão, como a pesquisa (`/nps`): o token do link é a credencial. Ele
 * vem no FRAGMENTO — que não vai ao servidor nem ao `Referer` — e é tirado da
 * barra assim que lido; a página o manda no CORPO de `POST /api/public/receipt`,
 * fora do caminho e portanto fora de todo log de acesso.
 *
 * O HTML do recibo é do servidor, com nomes que o provedor e o console
 * digitaram: ele é mostrado num `iframe` com `srcdoc` e `sandbox` SEM
 * `allow-scripts` nem `allow-same-origin` — nada nele roda, e nada nele alcança
 * esta página. O próprio documento ainda traz a CSP que não deixa rodar nada.
 * "Abrir em nova aba" leva o mesmo HTML como `blob:`, para imprimir ou salvar.
 */
export default function ReceiptPage() {
  const { t } = useTranslation()
  const [token] = useState(() => readReceiptToken(typeof window === 'undefined' ? '' : window.location.hash))
  const [estado, setEstado] = useState<'carregando' | 'pronto' | 'erro'>('carregando')
  const [erro, setErro] = useState('')
  const [html, setHtml] = useState('')
  const lido = useRef(false)

  useEffect(() => {
    if (lido.current) return
    lido.current = true
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
    if (!token) { setEstado('erro'); setErro(t('receiptPage.invalid')); return }
    void receiptAPI.open(token).then((res) => {
      if (res.ok) {
        setHtml(res.html)
        setEstado('pronto')
        return
      }
      setEstado('erro')
      setErro(t(res.status === 404 ? 'receiptPage.invalid' : 'receiptPage.failed'))
    }).catch(() => {
      setEstado('erro')
      setErro(t('receiptPage.failed'))
    })
  }, [t, token])

  const abrirEmNovaAba = () => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    window.open(url, '_blank', 'noopener,noreferrer')
    // A aba nova já leu o blob quando o tempo passa; a memória volta.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }

  return (
    <main className="flex min-h-screen items-start justify-center bg-background px-4 py-8">
      <div className="w-full max-w-3xl">
        <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
          <div className="flex items-center gap-3">
            <BrandMark className={`size-9 ${estado === 'carregando' ? 'animate-pulse' : ''}`} />
            <h1 className="text-lg font-bold text-foreground">{t('receiptPage.title')}</h1>
          </div>
          {estado === 'pronto' && (
            <button type="button" className="modern-button-secondary" onClick={abrirEmNovaAba}>
              {t('receiptPage.openTab')}
            </button>
          )}
        </div>

        {estado === 'carregando' && (
          <p className="mt-6 text-center text-sm text-muted-foreground" role="status" aria-live="polite">{t('common.loading')}</p>
        )}

        {estado === 'erro' && (
          <p className="mt-6 text-center text-sm leading-6 text-muted-foreground" role="alert">{erro}</p>
        )}

        {estado === 'pronto' && (
          <iframe
            title={t('receiptPage.frameTitle')}
            srcDoc={html}
            sandbox=""
            referrerPolicy="no-referrer"
            className="mt-4 h-[80vh] w-full rounded-md border border-border bg-white"
          />
        )}
      </div>
    </main>
  )
}
