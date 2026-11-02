'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { npsAPI, type NpsPublicView } from '@/lib/api'
import { BrandMark } from '@/components/brand-mark'
import { useTranslation } from '@/contexts/language-context'
import { NPS_SCORES, npsCategory, readNpsToken } from '@/lib/nps'

const COMMENT_MAX = 1000

/**
 * A pesquisa de satisfação dos provedores (NPS, 0123), aberta pelo link do
 * e-mail ou do WhatsApp: onze botões de 0 a 10 e um comentário opcional.
 *
 * Sem sessão, como a confirmação de e-mail: costuma ser aberta no celular, e o
 * token do link é a credencial. Ele vem no FRAGMENTO (`/nps#token`) e é tirado
 * da barra assim que lido — o fragmento não vai ao servidor nem ao `Referer`,
 * e fora da barra também não fica no histórico. As chamadas o levam no corpo.
 *
 * Quem já respondeu vê a nota e pode mudá-la por sete dias desde a primeira
 * resposta; depois disso a página só mostra o que foi respondido.
 */
export default function NpsPage() {
  const { t, formatDate } = useTranslation()
  const commentId = useId()
  const [token] = useState(() => readNpsToken(typeof window === 'undefined' ? '' : window.location.hash))
  const [estado, setEstado] = useState<'carregando' | 'pronto' | 'erro'>('carregando')
  const [erro, setErro] = useState('')
  const [view, setView] = useState<NpsPublicView | null>(null)
  const [score, setScore] = useState<number | null>(null)
  const [comment, setComment] = useState('')
  const [enviando, setEnviando] = useState(false)
  const [falhaEnvio, setFalhaEnvio] = useState('')
  const [salvo, setSalvo] = useState(false)
  const lido = useRef(false)

  useEffect(() => {
    if (lido.current) return
    lido.current = true
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname)
    if (!token) { setEstado('erro'); setErro(t('nps.notFound')); return }
    void npsAPI.lookup(token).then((res) => {
      if (res.success && res.data) {
        setView(res.data)
        setScore(res.data.score)
        setComment(res.data.comment ?? '')
        setEstado('pronto')
        return
      }
      setEstado('erro')
      setErro(t(res.code === 'expired' ? 'nps.expired' : 'nps.notFound'))
    }).catch(() => {
      setEstado('erro')
      setErro(t('nps.failed'))
    })
  }, [t, token])

  const enviar = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!token || score === null) { setFalhaEnvio(t('nps.pickScore')); return }
    setEnviando(true)
    setFalhaEnvio('')
    try {
      const res = await npsAPI.answer(token, { score, comment: comment.trim() || undefined })
      if (res.success && res.data) {
        setView(res.data)
        setSalvo(true)
      } else if (res.code === 'already_answered') {
        setView((v) => (v ? { ...v, canAnswer: false } : v))
        setFalhaEnvio(t('nps.locked'))
      } else if (res.code === 'expired') {
        setFalhaEnvio(t('nps.expired'))
      } else {
        setFalhaEnvio(t('nps.failed'))
      }
    } catch {
      setFalhaEnvio(t('nps.failed'))
    } finally {
      setEnviando(false)
    }
  }

  const tom = (n: number) => {
    const cat = npsCategory(n)
    if (cat === 'promoter') return 'border-[hsl(var(--status-success))]'
    if (cat === 'passive') return 'border-[hsl(var(--status-warning))]'
    return 'border-[hsl(var(--status-danger))]'
  }

  const respondida = view?.status === 'answered'
  const podeResponder = Boolean(view?.canAnswer)

  return (
    <main className="flex min-h-screen items-start justify-center bg-background px-4 py-10 sm:items-center">
      <div className="w-full max-w-xl">
        <BrandMark className={`mx-auto size-11 ${estado === 'carregando' ? 'animate-pulse' : ''}`} />
        <h1 className="mt-5 text-center text-xl font-bold text-foreground">{t('nps.title')}</h1>

        {estado === 'carregando' && (
          <p className="mt-6 text-center text-sm text-muted-foreground" role="status" aria-live="polite">{t('common.loading')}</p>
        )}

        {estado === 'erro' && (
          <p className="mt-6 text-center text-sm leading-6 text-muted-foreground" role="alert">{erro}</p>
        )}

        {estado === 'pronto' && view && (
          <form className="modern-card mt-6 space-y-5 p-4 sm:p-6" onSubmit={(e) => void enviar(e)}>
            <fieldset disabled={!podeResponder || enviando} className="space-y-3">
              <legend className="text-base font-semibold leading-6 text-foreground">
                {t('nps.question', { product: view.product })}
              </legend>
              <div className="grid grid-cols-6 gap-2 sm:grid-cols-11" role="radiogroup" aria-label={t('nps.title')}>
                {NPS_SCORES.map((n) => {
                  const marcado = score === n
                  return (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={marcado}
                      aria-label={t('nps.scoreAria', { score: n })}
                      onClick={() => { setScore(n); setFalhaEnvio('') }}
                      className={`min-h-11 rounded-md border-2 text-base font-semibold tabular-nums transition-colors disabled:opacity-60 ${
                        marcado ? `${tom(n)} bg-primary text-primary-foreground` : 'border-border bg-background text-foreground hover:bg-muted'
                      }`}
                    >
                      {n}
                    </button>
                  )
                })}
              </div>
              <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                <span>{t('nps.notLikely')}</span>
                <span className="text-right">{t('nps.veryLikely')}</span>
              </div>
            </fieldset>

            <div className="space-y-1">
              <label htmlFor={commentId} className="text-sm font-medium text-foreground">{t('nps.commentLabel')}</label>
              <textarea
                id={commentId}
                className="modern-input min-h-24 w-full"
                maxLength={COMMENT_MAX}
                value={comment}
                disabled={!podeResponder || enviando}
                placeholder={t('nps.commentPlaceholder')}
                onChange={(e) => setComment(e.target.value)}
              />
            </div>

            {falhaEnvio && <p className="text-sm text-destructive" role="alert">{falhaEnvio}</p>}
            {salvo && <p className="text-sm font-medium text-foreground" role="status" aria-live="polite">{t('nps.thanks')}</p>}
            {respondida && view.score !== null && !salvo && (
              <p className="text-sm text-muted-foreground">{t('nps.yourScore', { score: view.score })}</p>
            )}
            {respondida && podeResponder && view.editableUntil && (
              <p className="text-xs text-muted-foreground">{t('nps.editableUntil', { date: formatDate(view.editableUntil) })}</p>
            )}
            {respondida && !podeResponder && <p className="text-sm text-muted-foreground">{t('nps.locked')}</p>}

            {podeResponder && (
              <button type="submit" className="modern-button w-full sm:w-auto" disabled={enviando || score === null}>
                {enviando ? t('nps.sending') : t(respondida ? 'nps.update' : 'nps.submit')}
              </button>
            )}
          </form>
        )}
      </div>
    </main>
  )
}
