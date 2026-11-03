/**
 * As abas do mesmo navegador acompanhando a sessão umas das outras (0129).
 *
 * O token de acesso mora só na memória de cada aba, e o refresh no cookie
 * `HttpOnly`, que é do navegador inteiro. Não há mais `localStorage` com token
 * para o evento `storage` avisar, então as abas conversam por um
 * `BroadcastChannel`, e o que viaja nele é só o FATO — "saí", "entrei" —,
 * nunca um token.
 *
 * - `ignore`: a mensagem não é nossa, ou a sessão desta aba é só dela (a
 *   personificação mora no `sessionStorage` e não segue o navegador);
 * - `logout`: outra aba saiu, e o cookie foi junto; esta sai também;
 * - `reload`: outra aba ENTROU — talvez como outra pessoa ou em outro
 *   provedor, e o cookie agora é o dela. Recarregar é o jeito limpo de esta
 *   aba largar o que montou para a sessão anterior e voltar pela nova.
 */
export type CrossTabAction = 'ignore' | 'logout' | 'reload'

export const SESSION_CHANNEL = 'skygenpanel-session'

export type SessionMessage = { type: 'login' } | { type: 'logout' }

export function crossTabAction(message: unknown, ctx: { tabScoped: boolean }): CrossTabAction {
  if (ctx.tabScoped) return 'ignore'
  if (!message || typeof message !== 'object') return 'ignore'
  const tipo = (message as { type?: unknown }).type
  if (tipo === 'logout') return 'logout'
  if (tipo === 'login') return 'reload'
  return 'ignore'
}

/**
 * O canal, ou nada onde o navegador não o tem (testes sem DOM, navegadores
 * muito antigos): aí cada aba segue sozinha, que é o pior caso aceitável — a
 * próxima renovação dela é recusada e ela vai ao login.
 */
export function openSessionChannel(onMessage: (message: unknown) => void): { post: (m: SessionMessage) => void } {
  if (typeof BroadcastChannel === 'undefined') return { post: () => {} }
  try {
    const canal = new BroadcastChannel(SESSION_CHANNEL)
    canal.onmessage = (event) => onMessage(event.data)
    return {
      post: (m) => {
        try { canal.postMessage(m) } catch { /* canal fechado: nada a avisar */ }
      }
    }
  } catch {
    return { post: () => {} }
  }
}
