'use client'

import { useCallback, useEffect, useState } from 'react'
import { contactsAPI } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { useAuth } from '@/contexts/auth-context'

type Status = Awaited<ReturnType<typeof contactsAPI.asaasInvoices>>['data']

/**
 * O Asaas na ficha do cliente: o cliente ligado, ou "Criar no Asaas" quando o
 * provedor permitiu e ainda não existe lá. Só aparece com a integração ligada.
 *
 * A criação é o segundo passo, sobre um contato que já está salvo: se o Asaas
 * recusar, nada se perde e o botão continua aí para tentar de novo.
 */
export function AsaasCard({ contactKey, onChanged }: { contactKey: string; onChanged?: () => void }) {
  const { t } = useTranslation()
  const { can } = useAuth()
  const toast = useToast()
  const [status, setStatus] = useState<Status | null>(null)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    const res = await contactsAPI.asaasInvoices(contactKey)
    setStatus(res.success && res.data ? res.data : null)
  }, [contactKey])

  useEffect(() => { void load() }, [load])

  if (!status?.connected) return null
  const canCreate = status.canCreate && can('asaas.act')
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

  return (
    <section className="modern-card mt-5 p-5 sm:p-6" data-testid="asaas-card">
      <h2 className="section-heading mb-3">{t('contacts.profile.asaasTitle')}</h2>
      {status.customer ? (
        <p className="text-sm">
          {t('contacts.profile.asaasLinked', { id: status.customer.asaasId })}
          {status.customer.name && <span className="ms-2 text-muted-foreground">{status.customer.name}</span>}
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t('contacts.profile.asaasNotLinked')}</p>
          <button type="button" className="modern-button" disabled={creating} onClick={() => void create()}>
            {t(creating ? 'contacts.profile.asaasCreating' : 'contacts.profile.asaasCreate')}
          </button>
        </div>
      )}
    </section>
  )
}

