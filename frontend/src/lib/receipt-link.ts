/**
 * O token do recibo, que vem no FRAGMENTO (`/receipt#<token>`) — a parte do
 * endereço que o navegador não manda ao servidor. O formato é o do
 * `receiptLinkToken.js` do servidor: `<corpo base64url>.<hmac base64url>`.
 * Qualquer outra coisa é nulo, e a página diz que o link não vale.
 */
export function readReceiptToken(hash: string | null | undefined): string | null {
  const texto = String(hash ?? '').replace(/^#/, '').trim()
  return /^[A-Za-z0-9_-]{8,160}\.[A-Za-z0-9_-]{16,64}$/.test(texto) ? texto : null
}
