/**
 * Funções puras do formulário dos alertas técnicos (o vitest do projeto roda em
 * `node`): o que muda o botão Salvar e o campo do intervalo.
 */

/** O servidor limita a varredura a 60–3600 s; a tela fala em minutos. */
export const INTERVAL_MIN_MINUTES = 1
export const INTERVAL_MAX_MINUTES = 60

/** O intervalo guardado (segundos) como o campo em minutos, dentro dos limites. */
export function secondsToMinutes(seconds: number): string {
  const minutes = Math.round(Number(seconds) / 60)
  if (!Number.isFinite(minutes)) return String(INTERVAL_MIN_MINUTES)
  return String(Math.min(INTERVAL_MAX_MINUTES, Math.max(INTERVAL_MIN_MINUTES, minutes)))
}

/**
 * O campo em minutos como segundos para a API. Vazio ou ilegível volta ao que
 * já está guardado; fora dos limites é puxado para eles — a tela mostra o
 * número que de fato vale, em vez de o servidor trocá-lo em silêncio.
 */
export function minutesToSeconds(raw: string, storedSeconds: number): number {
  const text = String(raw ?? '').trim()
  const minutes = Number(text)
  if (!text || !Number.isFinite(minutes)) return storedSeconds
  return Math.min(INTERVAL_MAX_MINUTES, Math.max(INTERVAL_MIN_MINUTES, Math.round(minutes))) * 60
}

/**
 * O formulário mudou desde o último estado salvo?
 *
 * Os dois lados vêm da mesma função que monta o formulário (`toForm`), então a
 * ordem das chaves é a mesma e a comparação por texto basta. O token do
 * Telegram digitado e o "remover" contam como mudança: o campo começa vazio.
 */
export function isFormDirty(current: unknown, baseline: unknown): boolean {
  return JSON.stringify(current) !== JSON.stringify(baseline)
}
