import { useEffect, useMemo, useRef, useState } from 'react'
import { tenantAPI, usersAPI, type Operator } from '@/lib/api'
import { OperatorAvatar } from '@/components/settings/operator-avatar'
import { AVATAR_ACCEPT, avatarFileProblem, fileToAvatarDataUrl } from '@/lib/avatar-image'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { applyCep, emptyAddressForm } from '@/lib/contact-address'
import {
  emptyProfileForm, maskField, profileFormFrom, profilePayload, profileProblem,
  type ProfileForm, type ProfileFormKey
} from '@/lib/operator-profile'
import type { TranslationKey } from '@/lib/i18n'

interface FieldDef {
  key: ProfileFormKey
  label: TranslationKey
  type?: 'text' | 'date' | 'email' | 'textarea'
  inputMode?: 'numeric' | 'tel' | 'email'
  wide?: boolean
  max: number
  hint?: TranslationKey
}

const P = 'settings.operators.profile.' as const
const k = (name: string) => `${P}${name}` as TranslationKey

const SECTIONS: { title: TranslationKey; fields: FieldDef[] }[] = [
  {
    title: k('sectionPersonal'),
    fields: [
      { key: 'fullName', label: k('fullName'), wide: true, max: 160 },
      { key: 'cpf', label: k('cpf'), inputMode: 'numeric', max: 14, hint: k('cpfHint') },
      { key: 'rg', label: k('rg'), max: 32 },
      { key: 'birthDate', label: k('birthDate'), type: 'date', max: 10 }
    ]
  },
  {
    title: k('sectionContact'),
    fields: [
      { key: 'phone', label: k('phone'), inputMode: 'tel', max: 19 },
      { key: 'whatsapp', label: k('whatsapp'), inputMode: 'tel', max: 19 },
      { key: 'personalEmail', label: k('personalEmail'), type: 'email', inputMode: 'email', wide: true, max: 190 }
    ]
  },
  {
    title: k('sectionAddress'),
    fields: [
      { key: 'zip', label: k('zip'), inputMode: 'numeric', max: 9 },
      { key: 'street', label: k('street'), wide: true, max: 160 },
      { key: 'number', label: k('number'), max: 20 },
      { key: 'complement', label: k('complement'), max: 80 },
      { key: 'district', label: k('district'), max: 100 },
      { key: 'city', label: k('city'), max: 100 },
      { key: 'state', label: k('state'), max: 2 }
    ]
  },
  {
    title: k('sectionWork'),
    fields: [
      { key: 'jobTitle', label: k('jobTitle'), max: 100 },
      { key: 'admittedAt', label: k('admittedAt'), type: 'date', max: 10 },
      { key: 'emergencyName', label: k('emergencyName'), max: 120 },
      { key: 'emergencyPhone', label: k('emergencyPhone'), inputMode: 'tel', max: 19 },
      { key: 'notes', label: k('notes'), type: 'textarea', wide: true, max: 2000 }
    ]
  }
]

/**
 * "Editar" um operador: o login (usuário e e-mail) e o cadastro — nome, CPF,
 * contato, endereço e dados de trabalho.
 *
 * O servidor decide quem pode o quê; a tela só evita pedir o que ele recusa
 * (a própria pessoa não troca o login por aqui) e mostra a razão que ele der.
 * O login muda primeiro: se for recusado (nome em uso, por exemplo), o
 * cadastro não é gravado pela metade.
 */
export function OperatorEditDialog({ operator, isSelf, onClose, onSaved }: {
  operator: Operator
  isSelf: boolean
  onClose: () => void
  /** Chamado depois de gravar qualquer parte, para a lista recarregar. */
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [initial, setInitial] = useState<ProfileForm | null>(null)
  const [form, setForm] = useState<ProfileForm>(emptyProfileForm)
  const [loadFailed, setLoadFailed] = useState(false)
  const [username, setUsername] = useState(operator.username)
  const [email, setEmail] = useState(operator.email ?? '')
  const [saving, setSaving] = useState(false)
  const [lookingUp, setLookingUp] = useState(false)
  const [invalid, setInvalid] = useState<ProfileFormKey | null>(null)
  const first = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const [avatar, setAvatar] = useState<string | null>(operator.profile?.avatar ?? null)
  const [avatarBusy, setAvatarBusy] = useState(false)

  const load = async () => {
    setLoadFailed(false)
    const res = await usersAPI.profile(operator.id)
    if (res.success && res.data) {
      const loaded = profileFormFrom(res.data.profile)
      setInitial(loaded)
      setForm(loaded)
      setAvatar(res.data.profile.avatar ?? null)
    } else {
      setLoadFailed(true)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operator.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  useEffect(() => { if (initial) first.current?.focus() }, [initial])

  const loginPatch = useMemo(() => {
    const patch: { username?: string; email?: string } = {}
    if (username.trim() !== operator.username) patch.username = username.trim()
    if (email.trim().toLowerCase() !== (operator.email ?? '')) patch.email = email.trim()
    return patch
  }, [username, email, operator.username, operator.email])

  const profilePatch = useMemo(() => (initial ? profilePayload(form, initial) : {}), [form, initial])
  const dirty = Object.keys(loginPatch).length > 0 || Object.keys(profilePatch).length > 0

  const set = (key: ProfileFormKey, value: string) => {
    setForm((current) => ({ ...current, [key]: key === 'state' ? value.toUpperCase().slice(0, 2) : maskField(key, value) }))
    if (invalid === key) setInvalid(null)
  }

  const searchCep = async () => {
    setLookingUp(true)
    try {
      const res = await tenantAPI.lookupCep(form.zip)
      if (!res.success || !res.data) {
        toast.error(res.message || t(k('cepNotFound')))
        return
      }
      const next = applyCep(
        { ...emptyAddressForm(), street: form.street, number: form.number, complement: form.complement, district: form.district, city: form.city, state: form.state, zip: form.zip },
        { addressLine: res.data.addressLine ?? undefined, district: res.data.district ?? undefined, city: res.data.city ?? undefined, state: res.data.state ?? undefined },
        true
      )
      setForm((current) => ({ ...current, street: next.street, district: next.district, city: next.city, state: next.state }))
    } finally {
      setLookingUp(false)
    }
  }

  /** A foto grava na hora (rota própria), sem esperar o "Salvar" do resto do cadastro. */
  const chooseAvatar = async (file: File | undefined) => {
    if (!file) return
    const problem = avatarFileProblem(file)
    if (problem) {
      toast.error(t(problem === 'size' ? k('avatarTooBig') : k('avatarType')))
      return
    }
    setAvatarBusy(true)
    try {
      let image: string
      try {
        image = await fileToAvatarDataUrl(file)
      } catch {
        toast.error(t(k('avatarType')))
        return
      }
      const res = await usersAPI.setAvatar(operator.id, image)
      if (!res.success || !res.data) {
        toast.error(res.message || t(k('saveFailed')))
        return
      }
      setAvatar(res.data.profile.avatar ?? null)
      toast.success(t(k('avatarSaved')))
      onSaved()
    } finally {
      setAvatarBusy(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  const clearAvatar = async () => {
    setAvatarBusy(true)
    try {
      const res = await usersAPI.removeAvatar(operator.id)
      if (!res.success) {
        toast.error(res.message || t(k('saveFailed')))
        return
      }
      setAvatar(null)
      toast.success(t(k('avatarRemoved')))
      onSaved()
    } finally {
      setAvatarBusy(false)
    }
  }

  const save = async () => {
    const problem = profileProblem(form)
    if (problem) {
      setInvalid(problem.key)
      toast.error(t(problem.message as TranslationKey))
      return
    }
    setSaving(true)
    try {
      if (Object.keys(loginPatch).length) {
        const res = await usersAPI.update(operator.id, loginPatch)
        if (!res.success) {
          toast.error(res.message || t(k('saveFailed')))
          return
        }
      }
      if (Object.keys(profilePatch).length) {
        const res = await usersAPI.updateProfile(operator.id, profilePatch)
        if (!res.success) {
          if (res.code === 'cpf_in_use') setInvalid('cpf')
          toast.error(res.message || t(k('saveFailed')))
          onSaved()
          return
        }
      }
      toast.success(t(k('saved')))
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="operator-edit-title" data-testid="operator-edit">
      <form
        className="modal-panel modern-card flex max-h-[90vh] w-full max-w-3xl flex-col"
        onSubmit={(event) => { event.preventDefault(); if (dirty && !saving) void save() }}
      >
        <div className="border-b border-border p-5">
          <h2 id="operator-edit-title" className="text-base font-semibold">{t(k('title'), { username: operator.username })}</h2>
        </div>

        <div className="space-y-6 overflow-y-auto p-5">
          {!initial && !loadFailed && <p className="text-sm text-muted-foreground">{t(k('loading'))}</p>}
          {loadFailed && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm text-destructive">{t(k('loadFailed'))}</p>
              <button type="button" className="modern-button-secondary" onClick={() => void load()}>{t('common.retry')}</button>
            </div>
          )}

          {initial && (
            <>
              <section className="flex items-center gap-4">
                <OperatorAvatar src={avatar} name={form.fullName || operator.username} size={72} />
                <div className="min-w-0">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button" className="modern-button-secondary" disabled={avatarBusy}
                      onClick={() => fileInput.current?.click()}
                    >
                      {avatarBusy ? t('common.saving') : t(avatar ? k('avatarChange') : k('avatarChoose'))}
                    </button>
                    {avatar && (
                      <button type="button" className="modern-button-secondary" disabled={avatarBusy} onClick={() => void clearAvatar()}>
                        {t(k('avatarRemove'))}
                      </button>
                    )}
                  </div>
                  <p className="field-hint mt-1">{t(k('avatarHint'))}</p>
                  <input
                    ref={fileInput} type="file" accept={AVATAR_ACCEPT} className="sr-only" tabIndex={-1}
                    aria-label={t(k('avatarChoose'))} data-testid="operator-avatar-file"
                    onChange={(event) => void chooseAvatar(event.target.files?.[0])}
                  />
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold text-foreground">{t(k('sectionAccess'))}</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="operator-edit-username" className="field-label">{t(k('username'))}</label>
                    <input
                      id="operator-edit-username" ref={first} className="modern-input w-full" value={username}
                      onChange={(event) => setUsername(event.target.value)} disabled={isSelf} maxLength={64} autoComplete="off"
                    />
                  </div>
                  <div>
                    <label htmlFor="operator-edit-email" className="field-label">{t(k('email'))}</label>
                    <input
                      id="operator-edit-email" type="email" className="modern-input w-full" value={email}
                      onChange={(event) => setEmail(event.target.value)} disabled={isSelf} autoComplete="off"
                    />
                  </div>
                </div>
                <p className="field-hint mt-1">{t(isSelf ? k('loginLocked') : k('loginHint'))}</p>
              </section>

              {SECTIONS.map((section) => (
                <section key={section.title}>
                  <h3 className="mb-2 text-sm font-semibold text-foreground">{t(section.title)}</h3>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {section.fields.map((field) => {
                      const id = `operator-edit-${field.key}`
                      const common = {
                        id,
                        value: form[field.key],
                        maxLength: field.max,
                        'aria-invalid': invalid === field.key || undefined,
                        className: `modern-input w-full${invalid === field.key ? ' border-destructive' : ''}`,
                        onChange: (event: { target: { value: string } }) => set(field.key, event.target.value)
                      }
                      return (
                        <div key={field.key} className={field.wide ? 'sm:col-span-2' : undefined}>
                          <label htmlFor={id} className="field-label">{t(field.label)}</label>
                          {field.type === 'textarea' ? (
                            <textarea {...common} rows={3} />
                          ) : field.key === 'zip' ? (
                            <div className="flex gap-2">
                              <input {...common} inputMode="numeric" autoComplete="off" />
                              <button
                                type="button" className="modern-button-secondary shrink-0"
                                disabled={lookingUp || form.zip.replace(/\D/g, '').length !== 8}
                                onClick={() => void searchCep()}
                              >
                                {t(k('searchCep'))}
                              </button>
                            </div>
                          ) : (
                            <input {...common} type={field.type ?? 'text'} inputMode={field.inputMode} autoComplete="off" />
                          )}
                          {field.hint && <p className="field-hint mt-1">{t(field.hint)}</p>}
                        </div>
                      )
                    })}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-border p-4">
          <button type="button" className="modern-button-secondary" disabled={saving} onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="modern-button" disabled={!initial || !dirty || saving}>
            {saving ? t('common.saving') : t(k('save'))}
          </button>
        </div>
      </form>
    </div>
  )
}
