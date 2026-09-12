'use client'

import { useCallback, useEffect, useState } from 'react'
import { platformAPI, type OperatorRole, type Tenant, type TenantMembership } from '@/lib/api'
import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { OPERATOR_ROLES, ROLE_LABEL_KEYS } from '@/lib/permissions'

interface Props {
  tenant: Tenant
  /**
   * Attaching or ending a membership changes the operator count the provider
   * list shows, and that count comes from the list request rather than from
   * here, so the page is asked to read it again.
   */
  onMembershipChange: () => void
}

export function TenantMembers({ tenant, onMembershipChange }: Props) {
  const { t } = useTranslation()
  const toast = useToast()

  const [members, setMembers] = useState<TenantMembership[]>([])
  const [loading, setLoading] = useState(true)
  // `null` while the list is fine; otherwise the backend's reason, which may be
  // empty when the request failed without one.
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyUserId, setBusyUserId] = useState<number | null>(null)
  const [form, setForm] = useState<{ username: string; role: OperatorRole }>({ username: '', role: 'viewer' })
  const [convite, setConvite] = useState<{ role: OperatorRole; email: string }>({ role: 'owner', email: '' })
  const [convidando, setConvidando] = useState(false)
  // O convite cunhado, mostrado UMA vez: o banco guarda só o hash do token, e
  // nem esta tela nem nenhuma outra consegue dizê-lo de novo.
  const [cunhado, setCunhado] = useState<{ link: string | null; token: string; emailed: boolean } | null>(null)

  const tenantId = tenant.id

  const loadMembers = useCallback(async () => {
    setLoading(true)
    const res = await platformAPI.listMemberships(tenantId)
    if (res.success && res.data) {
      setMembers(res.data.memberships)
      setError(null)
    } else {
      setMembers([])
      setError(res.message || '')
    }
    setLoading(false)
  }, [tenantId])

  useEffect(() => {
    void loadMembers()
  }, [loadMembers])

  const submitMember = async () => {
    const username = form.username.trim()
    if (!username) return
    setSaving(true)
    try {
      const res = await platformAPI.addMembership(tenantId, { username, role: form.role })
      if (res.success) {
        setForm({ username: '', role: 'viewer' })
        await loadMembers()
        onMembershipChange()
      } else if (res.code === 'person_not_found') {
        // A recusa mais comum desta tela, e a única que tem próxima ação: quem
        // não existe no deploy não se vincula, se CONVIDA. A frase é nossa, e
        // não a do backend, porque o que falta dizer é o que fazer — e porque o
        // plano de controle responde em inglês.
        toast.error(t('platform.memberNotFound'))
      } else {
        // 409 para um vínculo que já existe, 402 para o limite do plano: o
        // backend diz qual, e nenhuma das duas vale uma chave própria.
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
    }
  }

  /**
   * Cunha o convite com que alguém que ainda não tem login entra na equipe.
   *
   * `owner` como padrão porque o caso que trouxe esta tela à existência é o
   * primeiro acesso de um provedor recém-criado, e quem recebe um painel vazio
   * recebe como dono dele.
   */
  const convidar = async () => {
    const email = convite.email.trim()
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast.error(t('settings.operators.emailInvalid'))
      return
    }
    setConvidando(true)
    try {
      const res = await platformAPI.inviteMember(tenantId, {
        role: convite.role,
        ...(email ? { email } : {})
      })
      if (!res.success || !res.data) {
        toast.error(res.message || t('invite.createFailed'))
        return
      }
      setCunhado({ link: res.data.url, token: res.data.token, emailed: res.data.emailed })
      setConvite((c) => ({ ...c, email: '' }))
    } finally {
      setConvidando(false)
    }
  }

  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto)
      toast.success(t('common.copied'))
    } catch {
      // Sem permissão de área de transferência o link fica na tela para ser
      // selecionado à mão; não é erro que valha um alarme.
    }
  }

  const removeMember = async (member: TenantMembership) => {
    if (!window.confirm(t('platform.removeMemberConfirm'))) return
    setBusyUserId(member.userId)
    try {
      const res = await platformAPI.removeMembership(tenantId, member.userId)
      if (res.success) {
        setMembers((current) => current.filter((item) => item.userId !== member.userId))
        onMembershipChange()
      } else {
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setBusyUserId(null)
    }
  }

  const roleLabel = (role: OperatorRole) => t(ROLE_LABEL_KEYS[role])

  return (
    <div className="space-y-4 py-3">
      <h3 className="font-semibold text-foreground">{t('platform.members')}</h3>

      {loading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : error !== null ? (
        <p className="text-sm text-destructive">{error || t('platform.loadFailed')}</p>
      ) : members.length === 0 ? (
        // `platform.empty` speaks about providers, not about people, so the
        // wording the operators list already uses for nobody stands in here.
        <p className="text-sm text-muted-foreground">{t('settings.operators.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border bg-card">
          {members.map((member) => (
            <li key={member.userId} className="flex items-center justify-between gap-3 px-3 py-2">
              <span className="min-w-0">
                <span className="truncate text-sm font-medium">{member.username}</span>
                <span className="modern-badge ms-2">{roleLabel(member.role)}</span>
              </span>
              <button
                type="button"
                onClick={() => void removeMember(member)}
                disabled={busyUserId === member.userId}
                className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                title={t('platform.removeMember')}
                aria-label={t('platform.removeMember')}
              >
                <Icon name="logout" size={18} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* Primeiro o convite, e não o vínculo: num provedor recém-criado não
          existe ninguém para vincular, e era esse o beco sem saída — a tela
          oferecia só a porta que não abre. */}
      <div className="rounded-md border border-border bg-card p-3">
        <h4 className="text-sm font-semibold text-foreground">{t('platform.inviteMember')}</h4>
        <p className="mb-2 mt-1 text-sm text-muted-foreground">{t('platform.inviteMemberHint')}</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="sm:w-72">
            <label htmlFor={`platform-invite-email-${tenantId}`} className="block text-sm font-medium mb-1">
              {t('invite.emailOptional')}
            </label>
            <input
              id={`platform-invite-email-${tenantId}`}
              type="email"
              value={convite.email}
              onChange={(e) => setConvite((c) => ({ ...c, email: e.target.value }))}
              className="modern-input w-full"
              placeholder={t('settings.operators.emailPlaceholder')}
              autoComplete="off"
            />
          </div>
          <select
            value={convite.role}
            onChange={(e) => setConvite((c) => ({ ...c, role: e.target.value as OperatorRole }))}
            className="modern-input sm:w-40"
            aria-label={t('settings.operators.role')}
          >
            {OPERATOR_ROLES.map((role) => (
              <option key={role} value={role}>{roleLabel(role)}</option>
            ))}
          </select>
          <button type="button" onClick={() => void convidar()} disabled={convidando} className="modern-button">
            {convidando ? t('common.saving') : t('invite.create')}
          </button>
        </div>
        <p className="field-hint">{t('invite.emailHint')}</p>

        {cunhado && (
          <div className="mt-3 rounded-md border border-border bg-[hsl(var(--surface-subtle))] p-3">
            <p className="text-sm font-medium text-foreground">
              {t(cunhado.emailed ? 'invite.mintedEmailed' : 'invite.minted')}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{t('invite.onceOnly')}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                className="modern-input flex-1 font-mono text-xs"
                readOnly
                value={cunhado.link ?? cunhado.token}
              />
              <button
                type="button"
                className="modern-button-secondary shrink-0"
                onClick={() => void copiar(cunhado.link ?? cunhado.token)}
              >
                <Icon name="copy" size={17} />
                {t('common.copy')}
              </button>
            </div>
            {/* Sem domínio-base o servidor não tem host para montar o link, e o
                que sobra é o token: quem entrega precisa saber que ele vale no
                endereço do provedor, com `/invite#` na frente. */}
            {cunhado.link === null && (
              <p className="field-hint">{t('platform.inviteNoAddress')}</p>
            )}
          </div>
        )}
      </div>

      <div className="rounded-md border border-border bg-card p-3">
        <h4 className="mb-2 text-sm font-semibold text-foreground">{t('platform.addMember')}</h4>
        <label htmlFor={`platform-member-username-${tenantId}`} className="block text-sm font-medium mb-1">
          {/* The person already exists, so this asks for the name they sign in
              with — the same field the operators list labels. */}
          {t('settings.operators.username')}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            id={`platform-member-username-${tenantId}`}
            value={form.username}
            onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            className="modern-input sm:w-72"
            autoComplete="off"
          />
          <select
            value={form.role}
            onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as OperatorRole }))}
            className="modern-input sm:w-40"
            aria-label={t('settings.operators.role')}
          >
            {/* Os quatro, `owner` inclusive: a regra de que só um `owner`
                promove outro vale entre colegas de um provedor, e o plano de
                controle está acima dela — o `platformMemberController` aceita
                qualquer um dos papéis aqui. */}
            {OPERATOR_ROLES.map((role) => (
              <option key={role} value={role}>{roleLabel(role)}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void submitMember()}
            disabled={saving || form.username.trim() === ''}
            className="modern-button"
          >
            {saving ? t('common.saving') : t('common.add')}
          </button>
        </div>
        <p className="field-hint">{t('platform.addMemberHint')}</p>
      </div>
    </div>
  )
}
