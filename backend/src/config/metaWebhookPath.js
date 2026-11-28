/**
 * O caminho da ponte de eventos da Meta, num lugar só (o mesmo motivo de
 * `waWebhookPath.js` e `messengerWebhookPath.js`): `app.js` monta a rota e o
 * serviço que registra o callback na Meta monta o endereço a partir desta
 * constante, e as duas pontas divergirem é a falha que isto existe para impedir.
 */
export const META_WEBHOOK_PATH = '/api/meta-webhook';
