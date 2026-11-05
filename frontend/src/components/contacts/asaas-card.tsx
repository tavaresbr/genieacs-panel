'use client'

import { useCallback, useEffect, useState } from 'react'
import { contactsAPI, type AsaasChargeView } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'
import { copyToClipboard, formatBrl, formatSgpDate, isSafeExternalUrl } from '@/lib/sgp'
import { parseAmountToCents } from '@/lib/utils'
import { SendInvoiceModal } from '@/components/contacts/send-invoice-modal'
import type { TranslationKey } from '@/lib/i18n'

type Status = Awaited<ReturnType<typeof contactsAPI.asaasInvoices>>['data']

const PAID = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH']

/** A situação da cobrança, na língua da tela. */
function statusKey(charge: AsaasChargeView): TranslationKey {
  if (charge.status === 'OVERDUE') return 'contacts.profile.asaasStatus.overdue'
  if (charge.open) return 'contacts.profile.asaasStatus.open'
  if (charge.status && PAID.includes(charge.status)) return 'contacts.profile.asaasStatus.paid'
  if (charge.status === 'REFUNDED') return 'contacts.profile.asaasStatus.refunded'
  return 'contacts.profile.asaasStatus.other'
}

/**
 * O Asaas na ficha do cliente: o cliente ligado (ou "Criar no Asaas"), e os
 * botões de trabalho — consultar os boletos, atualizar, mandar pelo WhatsApp e
 * gerar uma cobrança nova.
 *
 * Consultar e atualizar só LEEM do Asaas (e guardam a cópia no painel). A
 * cobrança nova é a única escrita, e só aparece quando o provedor a liberou e a
 * pessoa tem a capacidade. O Pix e a linha digitável nunca ficam guardados: são
 * pedidos ao Asaas na hora de copiar.
 */
export function AsaasCard({ contactKey, whatsappPhone = null, onChanged }: {
  contactKey: string
  whatsappPhone?: string | null
  onChanged?: () => void
}) {
  const { t, intlLocale, formatDateTime } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [status, setStatus] = useState<Status | null>(null)
  const [creating, setCreating] = useState(false)
  const [charges, setCharges] = useState<AsaasChargeView[] | null>(null)
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [copying, setCopying] = useState<string | null>(null)
  const [sending, setSending] = useState<string | null>(null)
  const [newCharge, setNewCharge] = useState(false)
  const [settling, setSettling] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await contactsAPI.asaasInvoices(contactKey)
    setStatus(res.success && res.data ? res.data : null)
  }, [contactKey])

  useEffect(() => { void load() }, [load])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await contactsAPI.refreshAsaas(contactKey)
      if (!res.success || !res.data) {
        toast.error(res.message || t('contacts.profile.asaasRefreshFailed'))
        return
      }
      setCharges(res.data.charges)
      setRefreshedAt(res.data.refreshedAt)
    } finally {
      setLoading(false)
    }
  }, [contactKey, toast, t])

  if (!status?.connected) return null
  const canCreate = status.canCreate && can('asaas.act')
  const canCharge = status.canCharge && can('asaas.act')
  if (!status.customer && !canCreate) return null

  const create = async () => {
    if (!window.confirm(t('contacts.profile.asaasCreateConfirm'))) return
    setCreating(true)
    try {
      const res = await contactsAPI.createInAsaas(contactKey)
      if (!res.success) {
        toast.error(res.message || t('contacts.profile.saveFailed'))
        return
      }
      toast.success(res.message || t('contacts.profile.asaasTitle'))
      await load()
      onChanged?.()
    } finally {
      setCreating(false)
    }
  }

  /** Baixa manual: o cliente pagou em dinheiro ou por um Pix fora do Asaas. */
  const settle = async (charge: AsaasChargeView) => {
    const message = t('contacts.profile.asaasSettleConfirm', {
      amount: formatBrl(charge.amount, intlLocale),
      date: formatSgpDate(charge.dueDate, intlLocale)
    })
    if (!window.confirm(message)) return
    setSettling(charge.id)
    try {
      const res = await contactsAPI.settleAsaasCharge(contactKey, charge.id)
      if (!res.success) {
        toast.error(res.message || t('contacts.profile.asaasSettleFailed'))
        return
      }
      toast.success(res.message || t('contacts.profile.asaasSettled'))
      await refresh()
      await load()
      onChanged?.()
    } finally {
      setSettling(null)
    }
  }

  /** Pede o código ao Asaas agora e o copia: nunca de uma cópia velha. */
  const copyCode = async (chargeId: string, which: 'digitableLine' | 'pix') => {
    setCopying(`${chargeId}:${which}`)
    try {
      const res = await contactsAPI.asaasChargeCodes(contactKey, chargeId)
      const value = res.success && res.data ? res.data[which] : null
      if (!value) {
        toast.error(res.message || t('contacts.profile.asaasNoCode'))
        if (res.data === undefined) void refresh()
        return
      }
      await copyToClipboard(value)
      toast.success(t('contacts.profile.copied'))
    } finally {
      setCopying(null)
    }
  }

  return (
    <section className="modern-card mt-5 p-5 sm:p-6" data-testid="asaas-card">
      <h2 className="section-heading mb-3">{t('contacts.profile.asaasTitle')}</h2>
      {status.customer ? (
        <>
          <p className="text-sm">
            {t('contacts.profile.asaasLinked', { id: status.customer.asaasId })}
            {status.customer.name && <span className="ms-2 text-muted-foreground">{status.customer.name}</span>}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {charges === null ? (
              <button type="button" className="modern-button" disabled={loading} onClick={() => void refresh()}>
                <Icon name="invoice" size={16} /> {loading ? t('contacts.profile.loading') : t('contacts.profile.asaasConsult')}
              </button>
            ) : (
              <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void refresh()}>
                <Icon name="refresh" size={16} /> {loading ? t('contacts.profile.loading') : t('contacts.profile.asaasRefresh')}
              </button>
            )}
            {canCharge && (
              <button type="button" className="modern-button-secondary" onClick={() => setNewCharge(true)}>
                <Icon name="invoice" size={16} /> {t('contacts.profile.asaasNewCharge')}
              </button>
            )}
          </div>

          {charges !== null && (
            <div className="mt-4">
              {charges.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('contacts.profile.asaasNoCharges')}</p>
              ) : (
                <ul className="divide-y divide-border" data-testid="asaas-charges">
                  {charges.map((charge) => (
                    <li key={charge.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                      <span>
                        <span className="font-semibold">{formatBrl(charge.amount, intlLocale)}</span>
                        <span className="ms-2 text-muted-foreground">
                          {t('contacts.profile.dueOn', { date: formatSgpDate(charge.dueDate, intlLocale) })}
                        </span>
                        <span className={`ms-2 ${charge.status === 'OVERDUE' ? 'modern-badge-warning' : charge.open ? 'modern-badge-info' : 'modern-badge'}`}>
                          {t(statusKey(charge))}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-2">
                        {charge.open && (
                          <>
                            <button
                              type="button"
                              className="modern-button-secondary"
                              disabled={copying !== null}
                              onClick={() => void copyCode(charge.id, 'digitableLine')}
                            >
                              <Icon name="copy" size={14} /> {t('contacts.profile.copyLine')}
                            </button>
                            <button
                              type="button"
                              className="modern-button-secondary"
                              disabled={copying !== null}
                              onClick={() => void copyCode(charge.id, 'pix')}
                            >
                              <Icon name="copy" size={14} /> PIX
                            </button>
                            {can('whatsapp.send') && (
                              <button
                                type="button"
                                className="modern-button-secondary"
                                disabled={!whatsappPhone}
                                title={whatsappPhone ? undefined : t('contacts.profile.sendInvoiceNoPhone')}
                                onClick={() => setSending(charge.id)}
                              >
                                <Icon name="chat" size={14} /> {t('contacts.profile.sendInvoice')}
                              </button>
                            )}
                            {/* Sempre à vista para quem pode agir: com a opção desligada o servidor
                                responde dizendo onde ligar, em vez de o botão simplesmente sumir. */}
                            {can('asaas.act') && (
                              <button
                                type="button"
                                className="modern-button-secondary"
                                disabled={settling !== null}
                                data-testid={`asaas-settle-${charge.id}`}
                                onClick={() => void settle(charge)}
                              >
                                <Icon name="check" size={14} /> {t('contacts.profile.asaasSettle')}
                              </button>
                            )}
                          </>
                        )}
                        {charge.link && isSafeExternalUrl(charge.link) && (
                          <a className="modern-button-secondary" href={charge.link} target="_blank" rel="noreferrer noopener">
                            <Icon name="external" size={14} /> {t('contacts.profile.asaasOpen')}
                          </a>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {refreshedAt && (
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('contacts.profile.asaasRefreshedAt', { date: formatDateTime(refreshedAt) })}
                </p>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t('contacts.profile.asaasNotLinked')}</p>
          <button type="button" className="modern-button" disabled={creating} onClick={() => void create()}>
            {t(creating ? 'contacts.profile.asaasCreating' : 'contacts.profile.asaasCreate')}
          </button>
        </div>
      )}

      {sending && <SendInvoiceModal contactKey={contactKey} invoiceId={sending} onClose={() => setSending(null)} />}
      {newCharge && (
        <NewChargeModal
          contactKey={contactKey}
          onClose={() => setNewCharge(false)}
          onCreated={() => { setNewCharge(false); void refresh(); onChanged?.() }}
        />
      )}
    </section>
  )
}

/** Hoje + `days`, no formato do campo de data. */
function inDays(days: number) {
  const d = new Date()
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * A cobrança nova: valor, vencimento, meio de pagamento e uma descrição. O
 * servidor confere de novo (mínimo do boleto, vencimento que não seja passado) —
 * a tela só poupa a ida quando o erro é óbvio.
 */
function NewChargeModal({ contactKey, onClose, onCreated }: { contactKey: string; onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const [value, setValue] = useState('')
  const [dueDate, setDueDate] = useState(inDays(3))
  const [billingType, setBillingType] = useState<'UNDEFINED' | 'BOLETO' | 'PIX'>('UNDEFINED')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)

  // Centavos inteiros, e `null` para o que é ambíguo ("1.234"): melhor pedir de novo do que cobrar mil a mais.
  const cents = parseAmountToCents(value)
  const invalid = cents === null || cents < 500 || !dueDate

  const submit = async () => {
    if (cents === null) return
    setBusy(true)
    try {
      const res = await contactsAPI.createAsaasCharge(contactKey, {
        value: cents / 100, dueDate, billingType, description: description.trim() || undefined
      })
      if (!res.success) {
        toast.error(res.message || t('contacts.profile.asaasChargeFailed'))
        return
      }
      toast.success(res.message || t('contacts.profile.asaasChargeCreated'))
      onCreated()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="asaas-new-charge-title">
      <div className="modal-panel modern-card max-w-md p-5 sm:p-6">
        <h2 id="asaas-new-charge-title" className="section-heading mb-1">{t('contacts.profile.asaasNewCharge')}</h2>
        <p className="section-description mb-4">{t('contacts.profile.asaasNewChargeHint')}</p>
        <div className="grid gap-4">
          <div>
            <label className="field-label" htmlFor="asaas-charge-value">{t('contacts.profile.asaasChargeValue')}</label>
            <input
              id="asaas-charge-value"
              className="modern-input"
              inputMode="decimal"
              placeholder="0,00"
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="asaas-charge-due">{t('contacts.profile.asaasChargeDue')}</label>
            <input
              id="asaas-charge-due"
              type="date"
              className="modern-input"
              min={inDays(0)}
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="asaas-charge-type">{t('contacts.profile.asaasChargeType')}</label>
            <select
              id="asaas-charge-type"
              className="modern-input"
              value={billingType}
              onChange={(event) => setBillingType(event.target.value as 'UNDEFINED' | 'BOLETO' | 'PIX')}
            >
              <option value="UNDEFINED">{t('contacts.profile.asaasTypeBoth')}</option>
              <option value="BOLETO">{t('contacts.profile.asaasTypeBoleto')}</option>
              <option value="PIX">Pix</option>
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor="asaas-charge-desc">{t('contacts.profile.asaasChargeDescription')}</label>
            <input
              id="asaas-charge-desc"
              className="modern-input"
              maxLength={500}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
        </div>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button type="button" className="modern-button-secondary" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="modern-button" disabled={busy || invalid} onClick={() => void submit()}>
            {busy ? t('contacts.profile.asaasCreating') : t('contacts.profile.asaasChargeCreate')}
          </button>
        </div>
      </div>
    </div>
  )
}
