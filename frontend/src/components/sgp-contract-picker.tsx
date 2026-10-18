import { useEffect, useState } from 'react'
import { sgpAPI, type SgpContractChoice, type SgpContractSearch } from '@/lib/api'
import { useTranslation } from '@/contexts/language-context'

const EMPTY: SgpContractSearch = { results: [], suggestions: [], reportedLogin: null }

/**
 * Campo de contrato com busca no cadastro sincronizado do SGP: o operador
 * acha o contrato pelo número, pelo nome, pelo CPF/CNPJ ou pelo login, em vez
 * de digitar um número às cegas. Os contratos cujo login é o da ONT vêm
 * antes, sem ninguém digitar.
 */
export function SgpContractPicker({
  deviceId,
  value,
  onChange
}: {
  deviceId: string
  value: string
  onChange: (contract: string) => void
}) {
  const { t } = useTranslation()
  const [data, setData] = useState<SgpContractSearch>(EMPTY)
  const [searching, setSearching] = useState(false)
  const term = value.trim()

  useEffect(() => {
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      sgpAPI
        .searchContracts(term, deviceId)
        .then((res) => {
          if (!cancelled) setData(res.success && res.data ? res.data : EMPTY)
        })
        .catch(() => {
          if (!cancelled) setData(EMPTY)
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [term, deviceId])

  const row = (choice: SgpContractChoice) => (
    <li key={choice.contract}>
      <button
        type="button"
        className="flex w-full flex-wrap items-baseline gap-x-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
        onClick={() => onChange(choice.contract)}
      >
        <span className="font-mono font-semibold">{choice.contract}</span>
        <span className="min-w-0 truncate">{choice.clientName || '—'}</span>
        {choice.login ? <span className="font-mono text-xs text-muted-foreground">{choice.login}</span> : null}
        {choice.statusLabel ? <span className="text-xs text-muted-foreground">{choice.statusLabel}</span> : null}
        {choice.linkedDevices.length > 0 ? (
          <span className="text-xs text-amber-600 dark:text-amber-400">{t('detail.sgp.alreadyLinked')}</span>
        ) : null}
      </button>
    </li>
  )

  const suggested = new Set(data.suggestions.map((choice) => choice.contract))
  const others = data.results.filter((choice) => !suggested.has(choice.contract))

  return (
    <div className="w-full sm:max-w-xl">
      <input
        type="text"
        className="modern-input w-full"
        placeholder={t('detail.sgp.searchPlaceholder')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {data.suggestions.length > 0 ? (
        <div className="mt-2">
          <p className="field-hint">{t('detail.sgp.suggestionsTitle', { login: data.reportedLogin ?? '' })}</p>
          <ul className="mt-1">{data.suggestions.map(row)}</ul>
        </div>
      ) : null}
      {others.length > 0 ? <ul className="mt-2">{others.map(row)}</ul> : null}
      {term && !searching && others.length === 0 && data.suggestions.length === 0 ? (
        <p className="field-hint mt-2">{t('detail.sgp.searchEmpty')}</p>
      ) : null}
    </div>
  )
}
