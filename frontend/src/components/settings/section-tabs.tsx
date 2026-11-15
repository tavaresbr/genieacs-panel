'use client'

import type { KeyboardEvent, ReactNode } from 'react'

export interface SectionTab {
  id: string
  label: string
  /** Só é montado quando a aba está ativa. */
  content: ReactNode
}

interface Props {
  tabs: SectionTab[]
  active: string
  onChange: (id: string) => void
  ariaLabel: string
  /** Prefixo dos ids, para duas faixas na mesma tela não repetirem ids. */
  idPrefix: string
}

/**
 * As abas de dentro de uma integração (SGP, WhatsApp, chatbot): uma faixa
 * logo abaixo do título e só o conteúdo da aba escolhida na tela. Usa a mesma
 * faixa das abas de Configuração, e quem a usa guarda a aba ativa — assim um
 * link com âncora (`#wa-accounts`) consegue abrir a aba certa.
 */
export function SectionTabs({ tabs, active, onChange, ariaLabel, idPrefix }: Props) {
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0]

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const next = tabs[(index + step + tabs.length) % tabs.length]
    onChange(next.id)
    document.getElementById(`${idPrefix}-tab-${next.id}`)?.focus()
  }

  return (
    <div>
      <div className="tab-rail mb-5" role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab, index) => {
          const selected = tab.id === current.id
          return (
            <button
              key={tab.id}
              id={`${idPrefix}-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel`}
              tabIndex={selected ? 0 : -1}
              data-active={selected}
              className="tab-button"
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      <div id={`${idPrefix}-panel`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${current.id}`}>
        {current.content}
      </div>
    </div>
  )
}

export default SectionTabs
