/**
 * O recuo da fila de avisos do Telegram: a MESMA curva das filas do WhatsApp e
 * do Messenger — 30 s, 1, 2, 4, 8 e 16 min, e sete tentativas no total.
 * Duplicada em vez de importada para esta fila não puxar o WhatsApp inteiro.
 */
export const MAX_ATTEMPTS = 7;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;

/** Quanto esperar depois da tentativa `attempts` (contando de um) que falhou. */
export function retryDelayMs(attempts) {
  const step = Math.max(1, Number(attempts) || 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** (step - 1), BACKOFF_CAP_MS);
}
