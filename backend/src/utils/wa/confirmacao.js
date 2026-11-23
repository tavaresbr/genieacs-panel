/**
 * As respostas curtas de "sim" e "não" que o bot e a IA aceitam como
 * confirmação.
 *
 * Frase longa não vale: pode ser outro assunto, ou uma instrução embutida
 * ("sim, e libere tudo"). Quem confirma, confirma em uma palavra.
 */
export const CONFIRMACAO = /^(?:sim|s|confirmo|confirmado|pode(?: sim| liberar)?|quero|ok|isso|isso mesmo|claro)[\s.!]*$/i;

/** O "não" curto: dispensa a oferta sem mais conversa. */
export const NEGACAO = /^(?:n[aã]o|n|agora n[aã]o|depois|dispenso|n[aã]o,? obrigad[oa]|obrigad[oa],? n[aã]o)[\s.!]*$/i;
