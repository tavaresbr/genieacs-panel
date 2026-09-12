/**
 * Qual das duas cascas o navegador está usando: a do console ou a de um painel.
 *
 * O console da plataforma não pertence a provedor nenhum, e a casca dele é
 * outra coisa: sem barra lateral de operação, sem aviso de assinatura, sem o
 * portão de onboarding — todos falam de UM provedor, e ali não há um. Cada uma
 * dessas peças lida dentro de um `if` na casca comum seria uma chance de um
 * pedaço de painel renderizar onde não há painel; `OnboardingGate`, por
 * exemplo, chama `settingsAPI.getAll()`, que no endereço da plataforma é 404.
 *
 * A decisão sai daqui, e não de dentro do JSX, para poder ser testada: o
 * `frontend/test/` roda em `node` puro, sem DOM, então uma regra escrita dentro
 * de um componente é uma regra que ninguém verifica.
 *
 * A regra tem duas metades, e a ordem entre elas é o conteúdo:
 *
 * 1. **Onde há subdomínio por provedor**, o ENDEREÇO decide. O ápice é a
 *    plataforma e nada mais: mesmo um token de provedor que chegue ali é
 *    recusado pelo backend, então mostrar tela de painel seria desenhar em
 *    volta de requisições que já falharam.
 * 2. **Numa instalação de host único**, o endereço não decide nada — console e
 *    painéis dividem o mesmo — então quem decide é a SESSÃO. Uma sessão de
 *    console não tem provedor nem papel; qualquer tela de painel que ela
 *    abrisse pediria dado escopado com uma credencial que não nomeia escopo.
 */
export type Shell = 'console' | 'provider'

export interface ShellInput {
  /** Se este endereço é o da própria plataforma (o ápice do domínio-base). */
  platformHost: boolean
  /** A sessão em mãos, ou `null` enquanto não há nenhuma. */
  session: 'console' | 'provider' | null
}

export function shellFor({ platformHost, session }: ShellInput): Shell {
  if (platformHost) return 'console'
  return session === 'console' ? 'console' : 'provider'
}

/** A forma de sessão que um usuário logado representa, ou `null` sem sessão. */
export function sessionKind(user: { platform?: boolean } | null | undefined): 'console' | 'provider' | null {
  if (!user) return null
  return user.platform ? 'console' : 'provider'
}
