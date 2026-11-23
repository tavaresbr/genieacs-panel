/** A janela de resposta do Messenger: 24 h depois da última mensagem da pessoa. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Se ainda dá para responder (fora da janela a Meta recusa, e é melhor dizer aqui). */
export function windowOpen(conversation, now = Date.now()) {
  if (!conversation?.last_inbound_at) return false;
  const last = new Date(conversation.last_inbound_at).getTime();
  return Number.isFinite(last) && now - last <= REPLY_WINDOW_MS;
}
