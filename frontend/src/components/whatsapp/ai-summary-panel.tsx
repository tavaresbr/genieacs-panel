import { Icon } from '@/components/ui/icon'
import { useToast } from '@/components/ui/toast'
import { useTranslation } from '@/contexts/language-context'
import { copyToClipboard } from '@/lib/utils'

interface AiSummaryPanelProps {
  /** `null` enquanto a IA escreve. */
  text: string | null
  /** Cola o resumo na caixa de resposta, já como nota interna (nada é enviado ao cliente). */
  onNote: (text: string) => void
  onClose: () => void
}

/**
 * O resumo da conversa feito pela IA, para quem vai assumir. Só leitura: o
 * atendente confere e, se quiser, o leva para a caixa como nota interna.
 */
export function AiSummaryPanel({ text, onNote, onClose }: AiSummaryPanelProps) {
  const { t } = useTranslation()
  const toast = useToast()
  return (
    <section
      className="border-b border-[hsl(var(--primary))]/40 bg-[hsl(var(--primary))]/5 px-3 py-3 sm:px-4"
      aria-live="polite"
      aria-label={t('whatsapp.ai.copilot.summaryTitle')}
    >
      <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-[hsl(var(--primary))]">
        <Icon name="sparkles" size={13} />
        {t('whatsapp.ai.copilot.summaryTitle')}
      </h3>
      {text === null ? (
        <p className="text-sm text-muted-foreground">{t('whatsapp.ai.copilot.summaryLoading')}</p>
      ) : (
        <>
          <p className="whitespace-pre-wrap break-words text-sm">{text}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className="modern-button-secondary min-h-9 px-3 py-1 text-xs" onClick={() => onNote(text)}>
              <Icon name="lock" size={13} />
              {t('whatsapp.ai.copilot.toNote')}
            </button>
            <button
              type="button"
              className="modern-button-secondary min-h-9 px-3 py-1 text-xs"
              onClick={async () => {
                if (await copyToClipboard(text)) toast.success(t('common.copied'))
              }}
            >
              <Icon name="copy" size={13} />
              {t('whatsapp.ai.copilot.copy')}
            </button>
            <button type="button" className="modern-button-secondary min-h-9 px-3 py-1 text-xs" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
