/**
 * O caminho em que o Telegram entrega as mensagens do bot de comandos.
 *
 * Constante isolada, como `waWebhookPath.js`: quem monta a rota (`app.js`) e
 * quem monta o endereço entregue ao `setWebhook` (o controlador) leem do mesmo
 * lugar, e uma ponta não pode divergir da outra.
 *
 * O provedor vai no caminho (`/api/telegram-webhook/<id>`) porque cada provedor
 * tem o SEU bot e o pedido chega sem sessão. O id sozinho não autoriza nada: o
 * que autoriza é o segredo do webhook no header `X-Telegram-Bot-Api-Secret-Token`.
 */
export const TELEGRAM_WEBHOOK_PATH = '/api/telegram-webhook';

/** O endereço completo do provedor, dada a origem pública do painel. */
export function telegramWebhookUrl(origin, tenantId) {
  return `${String(origin).replace(/\/+$/, '')}${TELEGRAM_WEBHOOK_PATH}/${Number(tenantId)}`;
}
