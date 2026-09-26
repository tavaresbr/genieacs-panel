/**
 * As regras das ações que não têm volta na ONT, fora do componente.
 *
 * O vitest roda em `node`, sem jsdom: função pura aqui é a forma de a decisão
 * ter teste.
 */

/**
 * Se o que foi digitado é o número de série do aparelho.
 *
 * A MESMA regra do backend (`DeviceService.factoryResetDevice`): sem ligar para
 * maiúsculas nem para espaços nas pontas, e o id do aparelho quando o ACS não
 * reporta série. O botão só se acende quando esta função diz sim — e o servidor
 * confere de novo, porque a API é chamada por quem não usa a tela.
 */
export function serialMatches(typed: string, serial: string | null | undefined, deviceId: string): boolean {
  const esperado = String(serial || deviceId).trim().toUpperCase()
  const digitado = String(typed ?? '').trim().toUpperCase()
  return digitado.length > 0 && digitado === esperado
}

/** A janela do "online" do painel: um inform nos últimos 10 minutos. */
const ONLINE_WINDOW_MS = 10 * 60 * 1000

/**
 * Se a ONT informou há pouco — e, portanto, provavelmente ainda está ligada.
 *
 * É o aviso da remoção do GenieACS: uma ONT ligada se cadastra de novo no
 * próximo inform, e a remoção que o operador acabou de confirmar não teria
 * servido para nada.
 */
export function informedRecently(lastInform: string | null | undefined, now: number = Date.now()): boolean {
  if (!lastInform) return false
  const quando = new Date(lastInform).getTime()
  if (!Number.isFinite(quando)) return false
  const idade = now - quando
  return idade >= 0 && idade < ONLINE_WINDOW_MS
}
