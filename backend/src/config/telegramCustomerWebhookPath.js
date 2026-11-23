/**
 * O caminho em que o Telegram entrega as mensagens do bot dos CLIENTES.
 *
 * Constante isolada, como `telegramWebhookPath.js`: quem monta a rota (`app.js`)
 * e quem monta o endereço entregue ao `setWebhook` (o controlador) leem do mesmo
 * lugar. O provedor vai no caminho porque cada provedor tem o SEU bot e o pedido
 * chega sem sessão; o que autoriza é o segredo do cabeçalho
 * `X-Telegram-Bot-Api-Secret-Token`, não o id.
 */
export const TELEGRAM_CUSTOMER_WEBHOOK_PATH = '/api/telegram-customer-webhook';

/** O endereço completo do provedor, dada a origem pública do painel. */
export function telegramCustomerWebhookUrl(origin, tenantId) {
  return `${String(origin).replace(/\/+$/, '')}${TELEGRAM_CUSTOMER_WEBHOOK_PATH}/${Number(tenantId)}`;
}
