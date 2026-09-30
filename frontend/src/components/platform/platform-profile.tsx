'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  platformAPI,
  PLATFORM_PROFILE_FIELDS,
  type PlatformProfile,
  type PlatformProfileField
} from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n/dictionary'

type Rascunho = Record<PlatformProfileField, string>

const VAZIO = Object.fromEntries(PLATFORM_PROFILE_FIELDS.map((campo) => [campo, ''])) as Rascunho

/** Os blocos do formulário, e os campos de cada um. */
const BLOCOS: {
  titulo: TranslationKey
  dica: TranslationKey
  campos: { campo: PlatformProfileField; rotulo: TranslationKey; placeholder?: string; tipo?: string; largo?: boolean }[]
}[] = [
  {
    titulo: 'platform.profile.company',
    dica: 'platform.profile.companyHint',
    campos: [
      { campo: 'tradeName', rotulo: 'platform.profile.tradeName', placeholder: 'TR69' },
      { campo: 'legalName', rotulo: 'platform.profile.legalName' },
      { campo: 'taxId', rotulo: 'platform.profile.taxId', placeholder: '00.000.000/0000-00' },
      { campo: 'address', rotulo: 'platform.profile.address', largo: true }
    ]
  },
  {
    titulo: 'platform.profile.contact',
    dica: 'platform.profile.contactHint',
    campos: [
      { campo: 'contactWhatsapp', rotulo: 'platform.profile.contactWhatsapp', placeholder: '(93) 99999-9999', tipo: 'tel' },
      { campo: 'contactEmail', rotulo: 'platform.profile.contactEmail', placeholder: 'contato@empresa.com.br', tipo: 'email' }
    ]
  },
  {
    titulo: 'platform.profile.notices',
    dica: 'platform.profile.noticesHint',
    campos: [
      { campo: 'notifyWhatsapp', rotulo: 'platform.profile.notifyWhatsapp', placeholder: '(93) 99999-9999', tipo: 'tel' },
      { campo: 'notifyEmail', rotulo: 'platform.profile.notifyEmail', placeholder: 'vendas@empresa.com.br', tipo: 'email' }
    ]
  },
  {
    titulo: 'platform.profile.social',
    dica: 'platform.profile.socialHint',
    campos: [
      { campo: 'instagram', rotulo: 'platform.profile.instagram', placeholder: '@empresa' },
      { campo: 'facebook', rotulo: 'platform.profile.facebook', placeholder: 'facebook.com/empresa' },
      { campo: 'youtube', rotulo: 'platform.profile.youtube', placeholder: '@empresa' },
      { campo: 'linkedin', rotulo: 'platform.profile.linkedin', placeholder: 'linkedin.com/company/empresa' }
    ]
  }
]

/** Exibe o que o banco guarda do jeito que se digita: telefone e CNPJ formatados. */
function paraTela(campo: PlatformProfileField, valor: string | null) {
  if (!valor) return ''
  if (campo === 'contactWhatsapp' || campo === 'notifyWhatsapp') {
    const d = valor.replace(/^55(?=\d{10,11}$)/, '')
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  }
  return valor
}

function mascaraCnpj(texto: string) {
  const d = texto.replace(/\D/g, '').slice(0, 14)
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2')
}

/**
 * Configurações → Dados do SaaS: a empresa que vende, como o site a mostra, e
 * para onde vão os avisos de cadastro e de pedido de demonstração.
 *
 * O `.env` continua valendo para o campo que nunca foi salvo aqui — o selo ao
 * lado de cada rótulo diz de onde o valor vem. Salvar vazio apaga o que foi
 * gravado e devolve o campo ao `.env`.
 */
export function PlatformProfileForm() {
  const { t } = useTranslation()
  const toast = useToast()
  const [perfil, setPerfil] = useState<PlatformProfile | null>(null)
  const [rascunho, setRascunho] = useState<Rascunho>(VAZIO)
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)

  const aplicar = useCallback((dados: PlatformProfile) => {
    setPerfil(dados)
    setRascunho(Object.fromEntries(
      PLATFORM_PROFILE_FIELDS.map((campo) => [campo, paraTela(campo, dados.values[campo])])
    ) as Rascunho)
  }, [])

  useEffect(() => {
    let vivo = true
    platformAPI.getPlatformProfile().then((res) => {
      if (!vivo) return
      if (res.success && res.data) aplicar(res.data)
      else setErro(res.message || t('platform.profile.loadFailed'))
    }).catch(() => { if (vivo) setErro(t('platform.profile.loadFailed')) })
    return () => { vivo = false }
  }, [aplicar, t])

  const salvar = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!perfil) return
    // Só o que mudou vai, para um campo que vem do `.env` não virar "gravado"
    // só porque o formulário o reenviou.
    const patch: Partial<Record<PlatformProfileField, string>> = {}
    for (const campo of PLATFORM_PROFILE_FIELDS) {
      if (rascunho[campo].trim() !== paraTela(campo, perfil.values[campo])) patch[campo] = rascunho[campo].trim()
    }
    if (!Object.keys(patch).length) {
      toast.success(t('platform.profile.nothingChanged'))
      return
    }
    setSalvando(true)
    try {
      const res = await platformAPI.updatePlatformProfile(patch)
      if (res.success && res.data) {
        aplicar(res.data)
        toast.success(t('platform.profile.saved'))
      } else {
        toast.error(res.message || t('platform.profile.saveFailed'))
      }
    } catch {
      toast.error(t('platform.profile.saveFailed'))
    } finally {
      setSalvando(false)
    }
  }

  const selo = (campo: PlatformProfileField) => {
    const origem = perfil?.sources[campo]
    if (!origem) return null
    return (
      <span className="ml-2 text-xs font-normal text-muted-foreground">
        · {t(origem === 'db' ? 'integrations.sourceDb' : 'integrations.sourceEnv')}
      </span>
    )
  }

  if (erro) return <p className="alert-error text-sm">{erro}</p>
  if (!perfil) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>

  return (
    <form onSubmit={salvar} className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('platform.settings.profile')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('platform.profile.description')}</p>
      </div>

      {!perfil.canSave && <p className="alert-warning text-sm">{t('platform.profile.noPlatformBox')}</p>}

      {BLOCOS.map((bloco) => (
        <section key={bloco.titulo} className="rounded-md border border-border p-4 sm:p-5">
          <h3 className="font-semibold text-foreground">{t(bloco.titulo)}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t(bloco.dica)}</p>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            {bloco.campos.map(({ campo, rotulo, placeholder, tipo, largo }) => (
              <div key={campo} className={largo ? 'sm:col-span-2' : ''}>
                <label htmlFor={`profile-${campo}`} className="field-label">
                  {t(rotulo)}
                  {selo(campo)}
                </label>
                <input
                  id={`profile-${campo}`}
                  type={tipo ?? 'text'}
                  className="modern-input w-full"
                  placeholder={placeholder}
                  value={rascunho[campo]}
                  disabled={!perfil.canSave}
                  onChange={(e) => {
                    const valor = campo === 'taxId' ? mascaraCnpj(e.target.value) : e.target.value
                    setRascunho((r) => ({ ...r, [campo]: valor }))
                  }}
                />
              </div>
            ))}
          </div>
        </section>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="modern-button" disabled={salvando || !perfil.canSave}>
          {salvando ? t('common.saving') : t('common.save')}
        </button>
        <p className="text-xs text-muted-foreground">{t('platform.profile.emptyHint')}</p>
      </div>
    </form>
  )
}

export default PlatformProfileForm
