'use client'

import { useState } from 'react'
import { platformAPI, type Plan } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

interface Props {
  plans: Plan[]
  /** A lista de provedores mostra o plano de cada um; mudar aqui muda lá. */
  onChange: () => void
}

/** O que os três campos de limite guardam enquanto são texto na tela. */
interface Rascunho {
  code: string
  name: string
  maxOperators: string
  maxSubscribers: string
  maxDevices: string
  price: string
  currency: string
  trialDays: string
  active: boolean
}

const VAZIO: Rascunho = {
  code: '', name: '', maxOperators: '', maxSubscribers: '', maxDevices: '',
  price: '', currency: 'BRL', trialDays: '14', active: true
}

/**
 * Campo de limite vazio quer dizer SEM LIMITE, e é por isso que ele vira
 * `null` e não zero.
 *
 * A diferença não é de estilo: `null` é o que o backend lê como ilimitado, e
 * zero é um limite de zero — um plano que não deixa cadastrar nem um operador.
 * Um campo em branco entendido como zero transformaria "não quero limitar
 * isto" em "proíba tudo", e o erro só apareceria no dia em que alguém
 * assinasse o plano.
 */
function limite(texto: string): number | null {
  const cru = texto.trim()
  if (!cru) return null
  const numero = Number(cru)
  return Number.isFinite(numero) && numero >= 0 ? Math.floor(numero) : null
}

/** `'89,90'` e `'89.90'` viram 8990. O banco guarda centavos, nunca fração. */
function centavos(texto: string): number {
  const numero = Number(texto.trim().replace(',', '.'))
  return Number.isFinite(numero) && numero >= 0 ? Math.round(numero * 100) : 0
}

function paraRascunho(plan: Plan): Rascunho {
  return {
    code: plan.code,
    name: plan.name,
    maxOperators: plan.limits.operators === null ? '' : String(plan.limits.operators),
    maxSubscribers: plan.limits.subscribers === null ? '' : String(plan.limits.subscribers),
    maxDevices: plan.limits.devices === null ? '' : String(plan.limits.devices),
    price: (plan.priceCents / 100).toFixed(2),
    currency: plan.currency,
    trialDays: String(plan.trialDays),
    active: plan.active
  }
}

function dinheiro(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'BRL' }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`
  }
}

/**
 * O catálogo de planos: o que a plataforma vende.
 *
 * A API de criar e editar plano existe desde a Fase 5 e não tinha tela — quem
 * operava o SaaS escolhia entre os planos que a migração semeou, ou chamava a
 * rota na mão. Esta é a tela.
 *
 * **O código de um plano não se edita depois de criado**, e é a única restrição
 * de forma aqui. Ele é a chave estável pela qual `subscriptions` aponta para o
 * plano e pela qual a tela de bloqueio decide o que dizer; trocá-lo renomearia
 * o que os provedores já assinam sem que nada na tela sugira isso. Preço,
 * limites e período de teste mudam à vontade — mas só valem para quem assinar
 * DEPOIS, porque a assinatura guarda o plano, não uma cópia dos números dele.
 *
 * Desativar não apaga: um plano inativo some da lista de escolha e continua
 * valendo para quem já o assina. É o que permite parar de vender um plano sem
 * mexer em contrato de ninguém — e é por isso que não há botão de excluir.
 */
export function PlanCatalog({ plans, onChange }: Props) {
  const { t } = useTranslation()
  const toast = useToast()

  const [criando, setCriando] = useState(false)
  const [editandoId, setEditandoId] = useState<number | null>(null)
  const [rascunho, setRascunho] = useState<Rascunho>(VAZIO)
  const [salvando, setSalvando] = useState(false)

  const abrirCriacao = () => {
    setEditandoId(null)
    setRascunho(VAZIO)
    setCriando(true)
  }

  const abrirEdicao = (plan: Plan) => {
    setCriando(false)
    setEditandoId(plan.id)
    setRascunho(paraRascunho(plan))
  }

  const fechar = () => {
    setCriando(false)
    setEditandoId(null)
    setRascunho(VAZIO)
  }

  const salvar = async () => {
    const nome = rascunho.name.trim()
    if (!nome) {
      toast.error(t('platform.plans.nameRequired'))
      return
    }
    const codigo = rascunho.code.trim().toLowerCase()
    if (criando && !/^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(codigo)) {
      toast.error(t('platform.plans.codeInvalid'))
      return
    }

    const comum = {
      name: nome,
      maxOperators: limite(rascunho.maxOperators),
      maxSubscribers: limite(rascunho.maxSubscribers),
      maxDevices: limite(rascunho.maxDevices),
      priceCents: centavos(rascunho.price),
      currency: rascunho.currency.trim().toUpperCase() || 'BRL',
      trialDays: Math.max(0, Math.floor(Number(rascunho.trialDays) || 0)),
      active: rascunho.active
    }

    setSalvando(true)
    try {
      const res = criando
        ? await platformAPI.createPlan({ code: codigo, ...comum })
        : await platformAPI.updatePlan(editandoId as number, comum)
      if (!res.success) {
        // 409 quando o código já existe, 400 quando um número não serve: o
        // backend diz qual, e isso ajuda mais do que uma frase genérica.
        toast.error(res.message || t('platform.plans.saveFailed'))
        return
      }
      fechar()
      onChange()
    } finally {
      setSalvando(false)
    }
  }

  /** Ligar e desligar sem abrir o formulário — é o que mais se faz aqui. */
  const alternarAtivo = async (plan: Plan) => {
    if (plan.active && (plan.subscribers ?? 0) > 0
      && !window.confirm(t('platform.plans.deactivateConfirm', { count: plan.subscribers ?? 0 }))) return
    setSalvando(true)
    try {
      const res = await platformAPI.updatePlan(plan.id, { active: !plan.active })
      if (!res.success) {
        toast.error(res.message || t('platform.plans.saveFailed'))
        return
      }
      onChange()
    } finally {
      setSalvando(false)
    }
  }

  const editandoEste = (plan: Plan) => editandoId === plan.id

  const formulario = (
    <div className="mt-4 space-y-4 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="field-label" htmlFor="plan-code">{t('platform.plans.code')}</label>
          <input
            id="plan-code" className="modern-input w-full" value={rascunho.code}
            disabled={!criando}
            onChange={(e) => setRascunho((r) => ({ ...r, code: e.target.value }))}
            placeholder="starter"
          />
          {/* O aviso só aparece na edição, que é quando ele significa algo. */}
          <p className="field-hint">{t(criando ? 'platform.plans.codeHint' : 'platform.plans.codeLocked')}</p>
        </div>
        <div>
          <label className="field-label" htmlFor="plan-name">{t('platform.plans.name')}</label>
          <input
            id="plan-name" className="modern-input w-full" value={rascunho.name}
            onChange={(e) => setRascunho((r) => ({ ...r, name: e.target.value }))}
            placeholder={t('platform.plans.namePlaceholder')}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {([
          ['maxOperators', 'platform.plans.maxOperators'],
          ['maxSubscribers', 'platform.plans.maxSubscribers'],
          ['maxDevices', 'platform.plans.maxDevices']
        ] as const).map(([campo, chave]) => (
          <div key={campo}>
            <label className="field-label" htmlFor={`plan-${campo}`}>{t(chave)}</label>
            <input
              id={`plan-${campo}`} type="number" min={0} className="modern-input w-full"
              value={rascunho[campo]}
              onChange={(e) => setRascunho((r) => ({ ...r, [campo]: e.target.value }))}
              placeholder={t('platform.plans.unlimited')}
            />
          </div>
        ))}
      </div>
      <p className="field-hint">{t('platform.plans.limitHint')}</p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="field-label" htmlFor="plan-price">{t('platform.plans.price')}</label>
          <input
            id="plan-price" className="modern-input w-full" inputMode="decimal"
            value={rascunho.price}
            onChange={(e) => setRascunho((r) => ({ ...r, price: e.target.value }))}
            placeholder="0,00"
          />
        </div>
        <div>
          <label className="field-label" htmlFor="plan-currency">{t('platform.plans.currency')}</label>
          <input
            id="plan-currency" className="modern-input w-full" maxLength={3}
            value={rascunho.currency}
            onChange={(e) => setRascunho((r) => ({ ...r, currency: e.target.value }))}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="plan-trial">{t('platform.plans.trialDays')}</label>
          <input
            id="plan-trial" type="number" min={0} className="modern-input w-full"
            value={rascunho.trialDays}
            onChange={(e) => setRascunho((r) => ({ ...r, trialDays: e.target.value }))}
          />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox" checked={rascunho.active}
          onChange={(e) => setRascunho((r) => ({ ...r, active: e.target.checked }))}
        />
        {t('platform.plans.active')}
      </label>

      <div className="flex gap-2">
        <button type="button" className="modern-button" disabled={salvando} onClick={() => void salvar()}>
          {salvando ? t('common.saving') : t('common.save')}
        </button>
        <button type="button" className="modern-button-secondary" onClick={fechar}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )

  return (
    <section className="rounded-md border border-border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold text-foreground">{t('platform.plans.title')}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('platform.plans.description')}</p>
        </div>
        <button type="button" className="modern-button shrink-0" onClick={abrirCriacao}>
          {t('platform.plans.create')}
        </button>
      </div>

      {criando && formulario}

      <div className="mt-4 space-y-3">
        {plans.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('platform.plans.empty')}</p>
        )}
        {plans.map((plan) => (
          <div key={plan.id} className="rounded-md border border-border p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{plan.name}</span>
                  <code className="rounded bg-[hsl(var(--surface-subtle))] px-1.5 py-0.5 text-xs">{plan.code}</code>
                  {/* `capitalize` porque `platform.plans.inactive` já existia
                      em minúsculas, como sufixo de um item de lista — e uma
                      chave quase igual só para a maiúscula seria pior do que
                      uma regra de estilo. */}
                  <span className={`capitalize ${plan.active ? 'modern-badge-success' : 'modern-badge-danger'}`}>
                    {t(plan.active ? 'platform.plans.active' : 'platform.plans.inactive')}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {dinheiro(plan.priceCents, plan.currency)}
                  {' · '}
                  {t('platform.plans.summaryLimits', {
                    operators: plan.limits.operators ?? '∞',
                    subscribers: plan.limits.subscribers ?? '∞',
                    devices: plan.limits.devices ?? '∞'
                  })}
                  {' · '}
                  {t('platform.plans.summaryTrial', { days: plan.trialDays })}
                  {plan.subscribers !== undefined && ` · ${t('platform.plans.summarySubscribers', { count: plan.subscribers })}`}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button" className="modern-button-secondary"
                  onClick={() => (editandoEste(plan) ? fechar() : abrirEdicao(plan))}
                >
                  <Icon name="settings" size={16} />
                  {t(editandoEste(plan) ? 'common.cancel' : 'common.edit')}
                </button>
                <button
                  type="button" className="modern-button-secondary" disabled={salvando}
                  onClick={() => void alternarAtivo(plan)}
                >
                  {t(plan.active ? 'platform.plans.deactivate' : 'platform.plans.activate')}
                </button>
              </div>
            </div>
            {editandoEste(plan) && formulario}
          </div>
        ))}
      </div>
    </section>
  )
}

export default PlanCatalog
