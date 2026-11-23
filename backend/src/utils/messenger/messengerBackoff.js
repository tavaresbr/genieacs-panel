/**
 * O recuo da fila do Messenger: a MESMA curva da fila do WhatsApp
 * (`waOutboxWorker.js`) — 30 s, 1, 2, 4, 8 e 16 min, e sete tentativas no total —,
 * porque a pergunta é a mesma (quanto de uma falha do outro lado uma resposta
 * digitada por gente aguenta). Duplicada em vez de importada para esta fila não
 * puxar o WhatsApp inteiro; `messenger-outbox.test.js` confere que as duas
 * continuam iguais.
 */
export const MAX_ATTEMPTS = 7;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;

/** Quanto esperar depois da tentativa `attempts` (contando de um) que falhou. */
export function retryDelayMs(attempts) {
  const step = Math.max(1, Number(attempts) || 1);
  return Math.min(BACKOFF_BASE_MS * 2 ** (step - 1), BACKOFF_CAP_MS);
}

/** Toda espera que uma mensagem atravessa antes de a fila desistir, em ordem. */
export function retryScheduleMs(maxAttempts = MAX_ATTEMPTS) {
  const waits = [];
  for (let attempt = 1; attempt < maxAttempts; attempt += 1) waits.push(retryDelayMs(attempt));
  return waits;
}
