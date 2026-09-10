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
      } else {
        // 404 for a name nobody holds, 409 for a membership that is already
        // there: the backend says which, and neither is worth its own key.
        toast.error(res.message || t('platform.saveFailed'))
      }
    } finally {
      setSaving(false)
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
                <span className="modern-badge ml-2">{roleLabel(member.role)}</span>
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
