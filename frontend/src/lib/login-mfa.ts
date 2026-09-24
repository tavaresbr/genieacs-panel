import type { ApiResponse } from '@/lib/api'

/**
 * A resposta do login pediu o código do app autenticador? E, se pediu, porque
 * faltava ou porque o que veio não serve?
 *
 * Pelo `code`, como o passo de escolher provedor (`login-destinations.ts`): a
 * frase é traduzida, e o 401 é o mesmo da senha errada. Confundir os dois é o
 * erro caro desta tela — dizer "senha inválida" a quem acertou a senha e só
 * precisa digitar o código, ou pedir código a quem errou a senha.
 */
export type MfaStep = 'required' | 'invalid'

export function mfaStepDaResposta(res: ApiResponse): MfaStep | null {
  if (res.success) return null
  if (res.code === 'mfa_required') return 'required'
  if (res.code === 'mfa_invalid') return 'invalid'
  return null
}

/**
 * O que a pessoa digitou no campo do código, limpo para mandar: o código do
 * app (6 dígitos, às vezes digitados com espaço no meio, como o app mostra) ou
 * um de recuperação ("xxxxx-xxxxx"), que o servidor normaliza.
 */
export function cleanSecondFactor(input: string): string {
  const texto = input.trim()
  const semEspaco = texto.replace(/\s/g, '')
  return /^\d{6}$/.test(semEspaco) ? semEspaco : texto
}
