'use client'

import { useState } from 'react'
import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n/dictionary'

export interface NavGroup<K extends string> {
  /** Chave i18n do título do grupo. */
  label: TranslationKey
  items: ReadonlyArray<readonly [K, TranslationKey, string?]>
}

/**
 * Menu lateral agrupado. No desktop é uma coluna com títulos de grupo; no
 * celular fica fechado, mostrando "Grupo › Item" atual, e abre numa gaveta.
 */
export function PlatformSidebar<K extends string>({ groups, active, onSelect, ariaLabel }: {
  groups: ReadonlyArray<NavGroup<K>>
  active: K
  onSelect: (key: K) => void
  ariaLabel: string
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const atual = groups.flatMap((g) => g.items.map(([k, r]) => ({ k, r, g: g.label }))).find((i) => i.k === active)

  return (
    <nav aria-label={ariaLabel} className="min-w-0">
      <button
        type="button"
        className="modern-button-secondary mb-2 flex w-full items-center justify-between lg:hidden"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{atual ? `${t(atual.g)} › ${t(atual.r)}` : ariaLabel}</span>
        <span aria-hidden>{open ? '▴' : '▾'}</span>
      </button>
      <div className={`${open ? 'block' : 'hidden'} lg:block`}>
        {groups.map((grupo) => (
          <div key={grupo.label} className="mb-3 flex flex-col gap-0.5 last:mb-0">
            <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              {t(grupo.label)}
            </p>
            {grupo.items.map(([chave, rotulo, icone]) => (
              <button
                key={chave}
                type="button"
                onClick={() => { onSelect(chave); setOpen(false) }}
                aria-current={active === chave ? 'page' : undefined}
                className={`flex items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm font-semibold transition ${active === chave
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
              >
                {icone && <Icon name={icone} size={16} className="shrink-0" />}
                {t(rotulo)}
              </button>
            ))}
          </div>
        ))}
      </div>
    </nav>
  )
}
