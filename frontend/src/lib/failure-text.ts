/**
 * O complemento do aviso quando o servidor recusou SEM um código que a tela
 * saiba traduzir: o status HTTP e o motivo curto que veio (`ENOSPC: no space
 * left on device`, por exemplo). Sem isto o operador lê só "A requisição
 * falhou" e ninguém sabe se foi disco, proxy ou o próprio servidor.
 * Só para rotas do próprio painel (o motivo é do nosso servidor, não do
 * Evolution).
 */
export function failureDetail({ status, error }: { status?: number; error?: string }, ignore: readonly string[] = []): string {
  const reason = String(error ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
  const parts: string[] = []
  if (status) parts.push(`HTTP ${status}`)
  if (reason && !ignore.includes(reason)) parts.push(reason)
  return parts.length ? ` (${parts.join(' · ')})` : ''
}
