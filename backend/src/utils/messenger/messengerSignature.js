import crypto from 'node:crypto';

/**
 * Confere o `X-Hub-Signature-256` de uma entrega da Meta.
 *
 * A assinatura é `sha256=<hex>`, o HMAC-SHA256 do corpo BRUTO com o segredo do
 * app. Tem de ser o corpo como chegou: reserializar o JSON muda bytes e a
 * assinatura deixa de bater. Falha fechada — sem segredo, sem cabeçalho ou com
 * formato estranho, recusa.
 *
 * @param {Buffer} rawBody
 * @param {string|undefined} header
 * @param {string|undefined} appSecret
 */
export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!appSecret || !Buffer.isBuffer(rawBody)) return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(String(header ?? '').trim());
  if (!match) return false;
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();
  const received = Buffer.from(match[1], 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

/** Compara dois segredos em tempo constante, sem vazar o tamanho de um deles. */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(ha, hb);
}
