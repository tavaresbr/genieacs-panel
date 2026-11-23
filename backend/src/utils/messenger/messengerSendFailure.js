/**
 * Separar uma falha de envio do Messenger em "tentar de novo" e "nunca".
 *
 * Aqui a Meta diz o que houve, com um código numérico, então a regra é diferente
 * da do WhatsApp (que lê o texto de um servidor intermediário e na dúvida tenta
 * de novo): o que é do TRANSPORTE ou da cota da Meta — rede fora, 5xx, 429,
 * limite de chamadas — passa, e o que a Meta recusou POR UM MOTIVO DELA (janela
 * fechada, pessoa indisponível, permissão, parâmetro inválido) não muda com o
 * tempo, e gastar meia hora de fila para ouvir a mesma recusa só esconde o
 * veredito de quem digitou a resposta.
 *
 * A dúvida cai para o lado de tentar de novo SÓ quando não há resposta da Meta
 * (a rede não chegou, o corpo não é lido) ou quando ela é de servidor.
 */

/** Códigos de erro da Graph que são de cota ou instabilidade: passam sozinhos. */
const TRANSIENT_CODES = new Set([
  1, // erro desconhecido, a Meta pede para tentar de novo
  2, // serviço temporariamente indisponível
  4, // limite de chamadas do app
  17, // limite de chamadas do usuário
  32, // limite de chamadas da Página
  341, // limite de aplicação
  613 // limite de chamadas
]);

/** O token da Página não vale mais: a Página precisa ser reconectada. */
const TOKEN_CODES = new Set([102, 190]);

/**
 * @param {{ ok?: boolean, status: number, data?: any }} result o que `graphRequest` devolveu
 * @returns {{ permanent: boolean, tokenInvalid: boolean }}
 */
export function classifyGraphFailure(result) {
  const status = Number(result?.status) || 0;
  const code = Number(result?.data?.error?.code);

  if (TOKEN_CODES.has(code) || status === 401) return { permanent: true, tokenInvalid: true };
  // Sem resposta (a rede não chegou) ou de servidor: a Meta pode estar só fora.
  if (status === 0 || status === 429 || status >= 500) return { permanent: false, tokenInvalid: false };
  if (TRANSIENT_CODES.has(code)) return { permanent: false, tokenInvalid: false };
  // Um 4xx com a recusa nomeada pela Meta: não muda com o tempo.
  return { permanent: true, tokenInvalid: false };
}
