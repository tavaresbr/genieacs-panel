'use client'

import { Fragment, useCallback, useEffect, useState } from 'react'
import { platformAPI, type Plan, type Tenant } from '@/lib/api'
import { PlanCatalog } from '@/components/platform/plan-catalog'
import { PlatformAdmins } from '@/components/platform/platform-admins'
import { PlatformAudit } from '@/components/platform/platform-audit'
import { TenantMembers } from '@/components/platform/tenant-members'
import { STATUS_LABEL_KEYS, TenantPlan, statusBadgeClass } from '@/components/platform/tenant-plan'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'

export default function PlatformPage() {
  const { t } = useTranslation()
  const toast = useToast()

  const [tenants, setTenants] = useState<Tenant[]>([])
  const [loading, setLoading] = useState(true)
  // `null` while the list is fine; otherwise the backend's reason, which may be
  // empty when the request failed without one.
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  // Which panel the expanded row shows: the team, or the plan and its statement.
  const [expandedPanel, setExpandedPanel] = useState<'members' | 'plan'>('members')
  const [plans, setPlans] = useState<Plan[]>([])
  const [form, setForm] = useState({ slug: '', name: '' })
  /**
   * Qual metade do console está na tela.
   *
   * Abas e não quatro telas porque as quatro respondem à mesma pergunta —
   * "como está a plataforma" — e porque o catálogo de planos só faz sentido ao
   * lado de quem os assina. Provedores é o padrão: é o que se abre para fazer
   * alguma coisa; as outras três são consulta ou manutenção rara.
   */
  const [aba, setAba] = useState<'tenants' | 'plans' | 'admins' | 'audit'>('tenants')

  const loadTenants = useCallback(async () => {
    const plansRes = await platformAPI.listPlans()
    if (plansRes.success && plansRes.data) setPlans(plansRes.data.plans)
    setLoading(true)
    const res = await platformAPI.listTenants()
    if (res.success && res.data) {
      setTenants(res.data.tenants)
      setError(null)
    } else {
      setTenants([])
      setError(res.message || '')
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadTenants()
  }, [loadTenants])

  const resetForm = () => {
    setForm({ slug: '', name: '' })
    setCreating(false)
  }

  const submitTenant = async () => {
    const slug = form.slug.trim()
    const name = form.name.trim()
    if (!slug || !name) return
    setSaving(true)
    try {
      const res = await platformAPI.createTenant({ slug, name })
      if (res.success) {
        resetForm()
        await loadTenants()
      } else {
        // 400 for a slug that is not a subdomain, 409 for one already taken:
        // the backend names which, and it says more than a generic line would.
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  /**
   * Abre uma sessão de leitura no painel de um provedor, em OUTRA ABA.
   *
   * O que volta é um endereço com um bilhete no fragmento, e o que se faz com
   * ele é ir para lá. Em outra aba porque quem olha o painel de um cliente
   * está no meio de um atendimento: voltar para a lista de provedores depois
   * custava um login novo no console, e a aba de trás guarda o lugar.
   *
   * A aba é aberta ANTES da chamada, ainda dentro do clique. Um `window.open`
   * depois do `await` chega sem gesto do usuário e o navegador o trata como
   * pop-up — o Safari bloqueia sempre, os outros às vezes. Ela nasce em branco
   * e recebe o endereço quando o bilhete volta; se o bilhete falhar, fecha.
   *
   * Sem `noopener`: com ele o navegador devolve `null` em vez da janela, e sem
   * a referência não há como levá-la ao endereço. O destino é o nosso próprio
   * `/impersonate`, não uma página de terceiro, então o que `noopener` protege
   * aqui não está em jogo.
   *
   * Vale para os dois tipos de instalação, com subdomínio por provedor ou num
   * host só. Nesta última o painel divide o origin com o console, e é por isso
   * que a sessão de personificação vive no `sessionStorage` — ver `tabOnly` em
   * `adoptSession`: sem isso a aba nova trocaria a sessão do console pela do
   * provedor e quebraria em silêncio a aba que se queria preservar.
   *
   * Uma única saída volta a navegar aqui mesmo: pop-up bloqueado, porque ir
   * para o painel nesta aba é melhor que não ir.
   *
   * Confirma antes porque a ação deixa rastro nos dois lados — na nossa trilha
   * e na do cliente — e porque entrar no painel de um cliente é coisa que se
   * faz de propósito, nunca por um clique errado numa linha vizinha.
   */
  const impersonar = async (tenant: Tenant) => {
    if (!window.confirm(t('platform.impersonateConfirm', { provider: tenant.name }))) return
    const aba = window.open('', '_blank')
    setBusyId(tenant.id)
    try {
      const res = await platformAPI.impersonate(tenant.id)
      if (!res.success || !res.data) {
        aba?.close()
        toast.error(res.message || t('platform.impersonateFailed'))
        return
      }
      const url = res.data.url
      if (aba) {
        // `replace` e não `assign`: a aba nova não tem histórico que valha, e o
        // `about:blank` no lugar dela deixaria um "voltar" que não volta.
        aba.location.replace(url)
        aba.focus()
        return
      }
      window.location.assign(url)
    } finally {
      setBusyId(null)
    }
  }

  /**
   * Apaga um provedor e tudo o que é dele.
   *
   * A confirmação pede o SLUG digitado, e não um "tem certeza?". A diferença
   * importa: um `confirm` é um Enter distraído, e isto não tem volta — leva os
   * assinantes, os equipamentos, as conversas e a trilha DELE. Digitar o nome
   * obriga a pessoa a olhar qual linha ela está prestes a apagar, que é
   * exatamente o erro que a tela precisa impedir.
   *
   * A comparação é frouxa de propósito (espaços e caixa), porque o que se quer
   * provar é atenção, não datilografia.
   */
  const apagar = async (tenant: Tenant) => {
    const digitado = window.prompt(t('platform.deletePrompt', { slug: tenant.slug, provider: tenant.name }))
    if (digitado === null) return
    if (digitado.trim().toLowerCase() !== tenant.slug.toLowerCase()) {
      toast.error(t('platform.deleteMismatch'))
      return
    }
    setBusyId(tenant.id)
    try {
      const res = await platformAPI.deleteTenant(tenant.id)
      if (!res.success) {
        toast.error(res.message || t('platform.deleteFailed'))
        return
      }
      toast.success(t('platform.deleted', { provider: tenant.name }))
      // A linha expandida pode ser justamente a que sumiu.
      setExpandedId(null)
      await loadTenants()
    } finally {
      setBusyId(null)
    }
  }

  const toggleStatus = async (tenant: Tenant) => {
    const next = tenant.status === 'active' ? 'suspended' : 'active'
    // Only suspending is asked about: it stops every background job for that
    // provider and locks its people out, while reactivating merely undoes it.
    if (next === 'suspended' && !window.confirm(t('platform.suspendConfirm'))) return
    setBusyId(tenant.id)
    try {
      const res = await platformAPI.setTenantStatus(tenant.id, next)
      const updated = res.success ? res.data?.tenant : undefined
      if (updated) {
        // The row itself flipping is the confirmation; there is no toast to
        // dismiss on top of it.
        setTenants((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="page-shell">
      <div className="page-frame">
        <header className="page-header">
          <div>
            <h1 className="page-title">{t('platform.title')}</h1>
            <p className="page-description">{t('platform.subtitle')}</p>
          </div>
          {/* Os dois botões são da aba de provedores; nas outras eles
              agiriam sobre o que não está na tela. */}
          {aba === 'tenants' && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => (creating ? resetForm() : setCreating(true))}
                className="modern-button"
              >
                <Icon name="building" size={17} />
                {t(creating ? 'common.cancel' : 'platform.newTenant')}
              </button>
              <button type="button" className="modern-button-secondary" disabled={loading} onClick={() => void loadTenants()}>
                <Icon name="refresh" size={17} className={loading ? 'animate-spin' : ''} />
                {t('common.refresh')}
              </button>
            </div>
          )}
        </header>

        <nav className="mb-6 flex flex-wrap gap-2" aria-label={t('platform.title')}>
          {([
            ['tenants', 'platform.tabs.tenants'],
            ['plans', 'platform.tabs.plans'],
            ['admins', 'platform.tabs.admins'],
            ['audit', 'platform.tabs.audit']
          ] as const).map(([chave, rotulo]) => (
            <button
              key={chave}
              type="button"
              onClick={() => setAba(chave)}
              aria-current={aba === chave ? 'page' : undefined}
              className={aba === chave ? 'modern-button' : 'modern-button-secondary'}
            >
              {t(rotulo)}
            </button>
          ))}
        </nav>

        {aba === 'plans' && <PlanCatalog plans={plans} onChange={() => void loadTenants()} />}
        {aba === 'admins' && <PlatformAdmins />}
        {aba === 'audit' && <PlatformAudit />}

        {aba === 'tenants' && creating && (
          <div className="modern-card mb-6 p-5 sm:p-6">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="tenant-slug" className="block text-sm font-medium mb-1">{t('platform.slug')}</label>
                <input
                  id="tenant-slug"
                  value={form.slug}
                  // Lower cased as it is typed: the slug becomes a hostname, and
                  // a capital typed here would only come back as a 400.
                  onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value.toLowerCase() }))}
                  className="modern-input w-full"
                  autoComplete="off"
                />
                <p className="field-hint">{t('platform.slugHint')}</p>
              </div>
              <div>
                <label htmlFor="tenant-name" className="block text-sm font-medium mb-1">{t('platform.name')}</label>
                <input
                  id="tenant-name"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="modern-input w-full"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void submitTenant()}
                disabled={saving || form.slug.trim() === '' || form.name.trim() === ''}
                className="modern-button"
              >
                {saving ? t('common.saving') : t('common.save')}
              </button>
              <button type="button" onClick={resetForm} className="modern-button-secondary">{t('common.cancel')}</button>
            </div>
          </div>
        )}

        {aba === 'tenants' && (
        <div className="modern-card overflow-x-auto">
          <table className="modern-table">
            <thead>
              <tr>
                <th>{t('platform.name')}</th>
                <th>{t('platform.slug')}</th>
                <th>{t('common.status')}</th>
                <th>{t('platform.subscription.plan')}</th>
                <th>{t('platform.members')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted-foreground">{t('common.loading')}</td>
                </tr>
              ) : error !== null ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-destructive">{error || t('platform.loadFailed')}</td>
                </tr>
              ) : tenants.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-muted-foreground">{t('platform.empty')}</td>
                </tr>
              ) : (
                tenants.map((tenant) => {
                  const active = tenant.status === 'active'
                  const expanded = expandedId === tenant.id
                  return (
                    <Fragment key={tenant.id}>
                      <tr>
                        <td className="font-medium">{tenant.name}</td>
                        <td className="font-mono text-sm">{tenant.slug}</td>
                        <td>
                          <span className={active ? 'modern-badge-success' : 'modern-badge-warning'}>
                            {t(active ? 'platform.statusActive' : 'platform.statusSuspended')}
                          </span>
                        </td>
                        <td className="text-sm">
                          {tenant.subscription ? (
                            <span className="flex flex-wrap items-center gap-2">
                              <span>{tenant.subscription.planName ?? tenant.subscription.planCode ?? '—'}</span>
                              <span className={statusBadgeClass(tenant.subscription.status)}>
                                {t(STATUS_LABEL_KEYS[tenant.subscription.status])}
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="text-sm text-muted-foreground">
                          {t('platform.operators', { count: tenant.operators })}
                        </td>
                        <td>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => {
                                setExpandedPanel('members')
                                setExpandedId((current) => (current === tenant.id && expandedPanel === 'members' ? null : tenant.id))
                              }}
                              className="modern-button-secondary"
                              aria-expanded={expanded && expandedPanel === 'members'}
                            >
                              {t('platform.members')}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setExpandedPanel('plan')
                                setExpandedId((current) => (current === tenant.id && expandedPanel === 'plan' ? null : tenant.id))
                              }}
                              className="modern-button-secondary"
                              aria-expanded={expanded && expandedPanel === 'plan'}
                            >
                              {t('platform.subscription.plan')}
                            </button>
                            {/* Só de um provedor ativo: o painel de um suspenso
                                está fora do ar para os operadores dele, e é
                                isso que a personificação mostraria. */}
                            {active && (
                              <button
                                type="button"
                                onClick={() => void impersonar(tenant)}
                                disabled={busyId === tenant.id}
                                className="modern-button-secondary"
                              >
                                <Icon name="eye" size={17} />
                                {t('platform.impersonate')}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => void toggleStatus(tenant)}
                              disabled={busyId === tenant.id}
                              className="modern-button-secondary"
                            >
                              <Icon name="power" size={17} />
                              {t(active ? 'platform.suspend' : 'platform.reactivate')}
                            </button>
                            {/* Só de um provedor SUSPENSO: apagar é o fim de
                                uma conversa que começou com a suspensão, e
                                exigir os dois passos dá ao cliente a janela
                                entre "seu painel parou" e "seus dados foram
                                embora". */}
                            {!active && (
                              <button
                                type="button"
                                onClick={() => void apagar(tenant)}
                                disabled={busyId === tenant.id}
                                className="modern-button-secondary text-destructive"
                              >
                                <Icon name="trash" size={17} />
                                {t('platform.delete')}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={6}>
                            {expandedPanel === 'members' ? (
                              <TenantMembers tenant={tenant} onMembershipChange={() => void loadTenants()} />
                            ) : (
                              <TenantPlan tenant={tenant} plans={plans} onSubscriptionChange={() => void loadTenants()} />
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
        )}
      </div>
    </div>
  )
}
