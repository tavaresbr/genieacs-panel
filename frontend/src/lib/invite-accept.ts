import type { InviteAcceptPayload } from '@/lib/api'

/**
 * Os dois jeitos de aceitar um convite, escolhidos pela PESSOA na tela.
 *
 * Antes o banco decidia: um formulário só, e o servidor olhava se o nome tinha
 * conta. Isso fazia do aceite um oráculo de quem tem conta no deploy — a
 * resposta mudava conforme o nome existia ou não — e cada palpite queimava a
 * trava da conta de outra pessoa. Agora quem já tem conta diz isso, e o
 * pedido de conta nova nunca confere senha de ninguém.
 */
export type InviteMode = 'new' | 'existing'

export interface InviteForm {
  username: string
  email: string
  password: string
}

/** O que a tela recusa antes de mandar, como chave de tradução. */
export type InviteFormProblem =
  | 'setup.error.usernameTooShort'
  | 'setup.error.passwordTooShort'
  | 'setup.error.emailInvalid'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function inviteFormProblem(mode: InviteMode, form: InviteForm): InviteFormProblem | null {
  if (form.username.trim().length < 3) return 'setup.error.usernameTooShort'
  // Sem mínimo aqui: quem já tem conta digita a senha que JÁ tem, e ela pode
  // ser de antes da regra de 10 caracteres. A regra da senha nova é do
  // servidor, que a aplica a quem está criando conta.
  if (!form.password) return 'setup.error.passwordTooShort'
  // O e-mail é só da conta nova: quem já tem conta entra com a que tem.
  if (mode === 'new' && !EMAIL.test(form.email.trim())) return 'setup.error.emailInvalid'
  return null
}

/**
 * O corpo do aceite. Quem já tem conta NÃO manda e-mail — mesmo que tenha
 * digitado um antes de trocar de aba —, e só ela manda o código do 2FA.
 */
export function inviteAcceptPayload(mode: InviteMode, form: InviteForm, totpCode?: string): InviteAcceptPayload {
  const username = form.username.trim()
  if (mode === 'existing') {
    return {
      existingAccount: true,
      username,
      password: form.password,
      ...(totpCode ? { totpCode } : {})
    }
  }
  return { username, email: form.email.trim(), password: form.password }
}
