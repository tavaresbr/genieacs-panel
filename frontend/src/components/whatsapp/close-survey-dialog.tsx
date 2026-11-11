'use client'

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { whatsappAPI, type SalesPlan, type SaleLostReason, type SaleResult } from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'

const REASONS: SaleLostReason[] = ['price', 'competitor', 'no_coverage', 'no_interest', 'other']
type Choice = 'unknown' | 'won' | 'lost'

/**
 * A janela de encerrar.
 *
 * Duas perguntas, cada uma só quando faz sentido:
 * - "Mandar a pesquisa de satisfação?" (`survey`): a pesquisa ("De 1 a 5...") sai
 *   sozinha ao encerrar, e o cliente que responde "obrigado" reabre a conversa —
 *   que então nunca acaba. Quem encerra decide, a cada vez.
 * - "Esta conversa era uma venda. Fechou?" (`sale`): a IA entregou a conversa como
 *   venda; dizer como terminou alimenta o relatório de vendas. "Não sei" não grava.
 */
export function CloseSurveyDialog({ busy, survey, sale, onChoose, onCancel }: {
  busy: boolean
  /** Encerrar mandaria a pesquisa de satisfação. */
  survey: boolean
  /** A conversa é uma venda entregue pela IA e ainda sem resultado. */
  sale: boolean
  onChoose: (survey: boolean, lead?: SaleResult) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const first = useRef<HTMLButtonElement>(null)
  const [choice, setChoice] = useState<Choice>('unknown')
  const [reason, setReason] = useState<SaleLostReason | ''>('')
  const [planId, setPlanId] = useState('')
  const [plans, setPlans] = useState<SalesPlan[]>([])

  useEffect(() => {
    first.current?.focus()
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  useEffect(() => {
    if (!sale) return
    let vivo = true
    // Sem a lista (sem permissão, falha de rede) o plano é opcional: a pergunta segue.
    void whatsappAPI.listSalesPlans().then((res) => { if (vivo && res.success && res.data) setPlans(res.data) }).catch(() => {})
    return () => { vivo = false }
  }, [sale])

  const result = (): SaleResult | undefined => {
    if (!sale) return undefined
    if (choice === 'won') return { outcome: 'won', ...(planId ? { planId: Number(planId) } : {}) }
    if (choice === 'lost' && reason) return { outcome: 'lost', reason }
    return undefined
  }
  const incomplete = sale && choice === 'lost' && !reason
  const labelOf = (c: Choice): TranslationKey => (c === 'won' ? 'whatsapp.closeSale.won' : c === 'lost' ? 'whatsapp.closeSale.lost' : 'whatsapp.closeSale.unknown')

  return createPortal(
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="close-survey-title">
      <button type="button" className="absolute inset-0 cursor-default" onClick={onCancel} aria-label={t('common.close')} tabIndex={-1} />
      <section className="modern-card relative w-full max-w-md space-y-4 p-5">
        <div>
          <h2 id="close-survey-title" className="text-lg font-semibold text-foreground">
            {survey ? t('whatsapp.closeSurvey.title') : t('whatsapp.closeSale.title')}
          </h2>
          {survey && <p className="mt-1 text-sm text-muted-foreground">{t('whatsapp.closeSurvey.hint')}</p>}
        </div>

        {sale && (
          <fieldset className="space-y-3 rounded-md border border-border p-3">
            <legend className="px-1 text-sm font-medium text-foreground">{t('whatsapp.closeSale.question')}</legend>
            <div className="flex gap-2" role="radiogroup" aria-label={t('whatsapp.closeSale.question')}>
              {(['won', 'lost', 'unknown'] as Choice[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={choice === c}
                  data-active={choice === c}
                  className={`modern-button-secondary min-h-10 flex-1 ${choice === c ? 'ring-2 ring-[hsl(var(--primary))]' : ''}`}
                  onClick={() => setChoice(c)}
                  disabled={busy}
                >
                  {t(labelOf(c))}
                </button>
              ))}
            </div>
            {choice === 'won' && plans.length > 0 && (
              <div>
                <label htmlFor="sale-plan" className="field-label">{t('whatsapp.closeSale.plan')}</label>
                <select id="sale-plan" className="modern-input w-full" value={planId} onChange={(e) => setPlanId(e.target.value)}>
                  <option value="">{t('whatsapp.closeSale.planNone')}</option>
                  {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            )}
            {choice === 'lost' && (
              <div>
                <label htmlFor="sale-reason" className="field-label">{t('whatsapp.closeSale.reason')}</label>
                <select id="sale-reason" className="modern-input w-full" value={reason} onChange={(e) => setReason(e.target.value as SaleLostReason | '')}>
                  <option value="">{t('whatsapp.closeSale.reasonPick')}</option>
                  {REASONS.map((r) => <option key={r} value={r}>{t(`whatsapp.closeSale.${r}` as TranslationKey)}</option>)}
                </select>
              </div>
            )}
          </fieldset>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="modern-button-secondary" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </button>
          {survey ? (
            <>
              <button type="button" className="modern-button-secondary" onClick={() => onChoose(false, result())} disabled={busy || incomplete}>
                {t('whatsapp.closeSurvey.skip')}
              </button>
              <button ref={first} type="button" className="modern-button" onClick={() => onChoose(true, result())} disabled={busy || incomplete}>
                {t('whatsapp.closeSurvey.send')}
              </button>
            </>
          ) : (
            <button ref={first} type="button" className="modern-button" onClick={() => onChoose(false, result())} disabled={busy || incomplete}>
              {t('whatsapp.closeSale.close')}
            </button>
          )}
        </div>
      </section>
    </div>,
    document.body
  )
}
