import { useCallback, useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import { parseWifiStatusFilter, type WifiStatusFilter } from '@/lib/wifi-filter'

/**
 * O filtro escolhido fica salvo no navegador, por tela (painel e portal têm
 * chaves próprias), para não voltar a "Todas" a cada equipamento aberto.
 */
export function useWifiStatusFilter(storageKey: string) {
  const [filter, setFilterState] = useState<WifiStatusFilter>(() => {
    try {
      return parseWifiStatusFilter(localStorage.getItem(storageKey))
    } catch {
      return 'all'
    }
  })

  const setFilter = useCallback((next: WifiStatusFilter) => {
    setFilterState(next)
    try {
      localStorage.setItem(storageKey, next)
    } catch {
      // Sem armazenamento, a escolha vale só para esta visita.
    }
  }, [storageKey])

  return [filter, setFilter] as const
}

interface WifiStatusFilterProps {
  value: WifiStatusFilter
  onChange: (next: WifiStatusFilter) => void
  counts: Record<WifiStatusFilter, number>
  className?: string
}

export function WifiStatusFilterControl({ value, onChange, counts, className }: WifiStatusFilterProps) {
  const { t } = useTranslation()
  const options = [
    ['all', 'detail.wifi.filterAll'],
    ['enabled', 'detail.wifi.filterEnabled'],
    ['disabled', 'detail.wifi.filterDisabled'],
  ] as const

  return (
    <div className={['tab-rail', className].filter(Boolean).join(' ')} role="group" aria-label={t('detail.wifi.filterAria')}>
      {options.map(([option, label]) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className="tab-button"
          data-active={value === option}
          aria-pressed={value === option}
        >
          {t(label, { count: counts[option] })}
        </button>
      ))}
    </div>
  )
}
