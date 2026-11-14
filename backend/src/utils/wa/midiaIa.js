/**
 * Fotos e PDFs que o cliente manda, para a IA ler (opt-in `ai.vision`, só
 * Claude). Só funções puras: que arquivo vale a pena mandar e que documento o
 * cliente de fato digitou. Ler os bytes fica em `WaAiService`.
 */

/** Quantas mídias do cliente a IA vê por vez, e quão recentes. */
export const MIDIAS_MAX = 3;
export const MIDIA_JANELA_MS = 24 * 3600_000;
const LIMITE_IMAGEM = 5 * 1024 * 1024;
const LIMITE_PDF = 10 * 1024 * 1024;

/** `image`, `document` ou null: só o que a API do Claude lê. */
export function tipoDeMidia(mime) {
  const m = String(mime ?? '').toLowerCase().split(';')[0].trim();
  if (/^image\/(?:jpeg|png|gif|webp)$/.test(m)) return 'image';
  if (m === 'application/pdf') return 'document';
  return null;
}

export const limiteDaMidia = (tipo) => (tipo === 'document' ? LIMITE_PDF : LIMITE_IMAGEM);

/**
 * Dentre as mensagens (mais antigas primeiro), os ids das últimas
 * `MIDIAS_MAX` do cliente com mídia legível e dentro da janela.
 */
export function escolherMidias(linhas, agora = Date.now()) {
  const validas = linhas.filter((m) => (
    m.direction === 'in'
    && m.attachment_path
    && tipoDeMidia(m.attachment_type)
    && agora - new Date(m.created_at).getTime() <= MIDIA_JANELA_MS
  ));
  return new Set(validas.slice(-MIDIAS_MAX).map((m) => m.id));
}

/** O documento (só dígitos) aparece no que o cliente digitou? O que está numa foto não vale. */
export function documentoDigitado(textos, digitos) {
  const alvo = String(digitos ?? '').replace(/\D/g, '');
  if (!alvo) return false;
  return textos.some((t) => String(t ?? '').replace(/\D/g, '').includes(alvo));
}

/** O que a IA deve saber quando pode ver fotos e PDFs. */
export const REGRA_DE_MIDIA = [
  'O cliente pode mandar fotos e PDFs; você as vê. Use só para ajudar no que ele pediu (comprovante, luzes do roteador, boleto).',
  'Não repita números de documento, cartão ou chave PIX que aparecerem numa imagem. Nunca use um CPF/CNPJ visto numa imagem em identificar_cliente: peça que o cliente o digite.',
  'Comprovante de pagamento: diga que recebeu e que a equipe vai conferir; nunca afirme que o pagamento foi confirmado nem que a conta está quitada.'
].join('\n');
