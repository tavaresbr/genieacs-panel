import crypto from 'node:crypto';

const b64url = (buffer) => buffer.toString('base64url');

/**
 * Lê o `signed_request` que a Meta manda nos avisos de desautorização e de
 * exclusão de dados: `<assinatura>.<carga>`, os dois em base64url; a assinatura
 * é o HMAC-SHA256 da carga (a string, como chegou) com o segredo do app.
 *
 * Falha fechada: sem segredo, assinatura que não bate, algoritmo diferente de
 * HMAC-SHA256 ou carga ilegível devolvem `null`.
 *
 * @returns {{ userId: string, issuedAt: number|null }|null}
 */
export function parseSignedRequest(signedRequest, appSecret) {
  if (!appSecret || typeof signedRequest !== 'string') return null;
  const parts = signedRequest.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [signature, payload] = parts;
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest();
  let received;
  try {
    received = Buffer.from(signature, 'base64url');
  } catch {
    return null;
  }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (String(data?.algorithm ?? '').toUpperCase() !== 'HMAC-SHA256') return null;
  const userId = String(data?.user_id ?? '');
  if (!/^\d{1,32}$/.test(userId)) return null;
  const issuedAt = Number(data?.issued_at);
  return { userId, issuedAt: Number.isFinite(issuedAt) ? issuedAt : null };
}

/** Para os testes (e só): monta um `signed_request` válido. */
export function signRequestForTest(payload, appSecret) {
  const body = b64url(Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', ...payload })));
  const sig = b64url(crypto.createHmac('sha256', appSecret).update(body).digest());
  return `${sig}.${body}`;
}

/**
 * O código de confirmação da exclusão: sem estado, e verificável. Carrega a
 * hora do pedido e um trecho aleatório, e é amarrado ao segredo do app por um
 * HMAC — a página de status só confirma códigos que o próprio painel emitiu.
 */
export function issueConfirmationCode(appSecret, now = Date.now()) {
  const stamp = Math.floor(now / 1000).toString(16);
  const nonce = crypto.randomBytes(6).toString('hex');
  const mac = crypto.createHmac('sha256', appSecret).update(`fb-deletion:${stamp}:${nonce}`).digest('hex').slice(0, 16);
  return `${stamp}-${nonce}-${mac}`;
}

/** @returns {Date|null} quando o código foi emitido, ou `null` se não é nosso. */
export function readConfirmationCode(code, appSecret) {
  const match = /^([0-9a-f]{1,12})-([0-9a-f]{12})-([0-9a-f]{16})$/.exec(String(code ?? ''));
  if (!appSecret || !match) return null;
  const [, stamp, nonce, mac] = match;
  const expected = crypto.createHmac('sha256', appSecret).update(`fb-deletion:${stamp}:${nonce}`).digest('hex').slice(0, 16);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return new Date(parseInt(stamp, 16) * 1000);
}
