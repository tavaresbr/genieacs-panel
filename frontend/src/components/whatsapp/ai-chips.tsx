import { useTranslation } from '@/contexts/language-context'
import type { WhatsAppConversation } from '@/lib/api'

/**
 * O que a IA marcou na conversa (opt-in na aba Chatbot): assunto, e urgência e
 * humor só quando pedem atenção — "calma" e "baixa" não viram ruído.
 */
export function AiChips({ conversation }: { conversation: WhatsAppConversation }) {
  const { t } = useTranslation()
  if (!conversation.aiTopic && !conversation.aiUrgency && !conversation.aiMood) return null
  const hint = t('whatsapp.ai.chip.hint')
  const topic = {
    fatura: t('whatsapp.ai.chip.topicFatura'),
    suporte: t('whatsapp.ai.chip.topicSuporte'),
    comercial: t('whatsapp.ai.chip.topicComercial'),
    cancelamento: t('whatsapp.ai.chip.topicCancelamento'),
    reclamacao: t('whatsapp.ai.chip.topicReclamacao'),
    elogio: t('whatsapp.ai.chip.topicElogio'),
    outro: t('whatsapp.ai.chip.topicOutro')
  }[conversation.aiTopic ?? 'outro']
  return (
    <>
      {conversation.aiUrgency === 'alta' && <span className="modern-badge-error" title={hint}>{t('whatsapp.ai.chip.urgent')}</span>}
      {conversation.aiUrgency === 'media' && <span className="modern-badge-warning" title={hint}>{t('whatsapp.ai.chip.medium')}</span>}
      {conversation.aiMood === 'irritado' && <span className="modern-badge-error" title={hint}>{t('whatsapp.ai.chip.irritated')}</span>}
      {conversation.aiMood === 'satisfeito' && <span className="modern-badge-success" title={hint}>{t('whatsapp.ai.chip.satisfied')}</span>}
      {conversation.aiTopic && <span className="modern-badge" title={hint}>{topic}</span>}
    </>
  )
}
