'use client'

import { useState } from 'react'
import { useTranslation } from '@/contexts/language-context'
import type { TranslationKey } from '@/lib/i18n'
import { BillingPanel } from './billing-panel'
import { DunningHistoryPanel } from './dunning-history-panel'
import { DunningRulePanel } from './dunning-rule-panel'

type View = 'auto' | 'manual' | 'history'

const VIEWS: [View, TranslationKey][] = [
  ['auto', 'whatsapp.dunning.tabAuto'],
  ['manual', 'whatsapp.dunning.tabManual'],
  ['history', 'whatsapp.dunning.tabHistory']
]

/**
 * The "Régua de cobrança" tab: the automatic cadence, the one-off builder that
 * was here first, and what the automatic one has done.
 *
 * Automatic first because it is what runs every day; the one-off builder keeps
 * its rule — building never sends — and stays one click away. Only the open
 * view is mounted: the one-off builder calls the ERP once per subscriber the
 * moment it appears, and nobody who came to edit the steps asked for that.
 */
export function DunningSection() {
  const { t } = useTranslation()
  const [view, setView] = useState<View>('auto')

  return (
    <div className="space-y-5">
      <div className="tab-rail" role="tablist" aria-label={t('whatsapp.billing.title')}>
        {VIEWS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="tab-button"
            role="tab"
            data-active={view === id}
            aria-selected={view === id}
            onClick={() => setView(id)}
          >
            {t(label)}
          </button>
        ))}
      </div>
      {view === 'auto' && <DunningRulePanel />}
      {view === 'manual' && <BillingPanel />}
      {view === 'history' && <DunningHistoryPanel />}
    </div>
  )
}
