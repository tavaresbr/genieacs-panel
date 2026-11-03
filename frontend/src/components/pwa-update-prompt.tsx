import { Icon } from '@/components/ui/icon'
import { useTranslation } from '@/contexts/language-context'
import { applyUpdate, dismissUpdate, usePwa } from '@/lib/pwa'

/**
 * "Nova versão do painel disponível" (0130): o service worker novo fica
 * esperando até a pessoa escolher a hora — atualizar sozinho no meio de um
 * formulário perderia o que ela digitava. Fica na casca, em toda tela.
 */
export function PwaUpdatePrompt() {
  const { t } = useTranslation()
  const { updateReady } = usePwa()
  if (!updateReady) return null
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-4 bottom-4 z-2100 flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-3 shadow-lg sm:inset-x-auto sm:inset-e-5 sm:w-[24rem]"
    >
      <Icon name="refresh" size={18} className="shrink-0" />
      <span className="min-w-0 flex-1 text-sm text-foreground">{t('pwa.updateReady')}</span>
      <button type="button" className="modern-button-secondary" onClick={dismissUpdate}>{t('pwa.later')}</button>
      <button type="button" className="modern-button" onClick={applyUpdate}>{t('pwa.update')}</button>
    </div>
  )
}
