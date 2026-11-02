/**
 * O que não sai do painel para o provedor de IA: CPF/CNPJ (com ou sem
 * pontuação) e a linha digitável / chave PIX copia-e-cola de uma fatura.
 * O modelo não precisa do documento para atender; quem confere é o painel.
 */
const CPF = /(?<!\d)\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2}(?!\d)/g;
const CNPJ = /(?<!\d)\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}(?!\d)/g;
// Linha digitável de boleto: 47/48 dígitos, em blocos separados por ponto/espaço.
const LINHA = /(?<!\d)(?:\d[\s.]?){46,47}\d(?!\d)/g;
// PIX copia-e-cola (EMV): começa em 000201.
const PIX = /000201[0-9A-Za-z./:@_ -]{40,}/g;

export function mascararSensivel(texto) {
  return String(texto ?? '')
    .replace(PIX, '[PIX omitido]')
    .replace(LINHA, '[linha digitável omitida]')
    .replace(CNPJ, '[documento omitido]')
    .replace(CPF, '[documento omitido]');
}

/**
 * O nome que o cliente pôs no WhatsApp, para entrar no prompt da IA como dado:
 * sem caracteres de controle ou de direção de texto, numa linha, curto.
 */
export function nomeSeguro(nome) {
  return String(nome ?? '')
    .replace(/[\p{C}\u202A-\u202E\u2066-\u2069\u200E\u200F]/gu, ' ')
    .replace(/["`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}
