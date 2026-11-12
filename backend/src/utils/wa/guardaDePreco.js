/**
 * A trava de preço da IA de vendas: um valor em reais que a IA escreve para quem
 * ainda não é cliente só vale se o provedor o cadastrou (no catálogo de planos ou
 * no texto das instruções). O resto é preço inventado, e a mensagem não sai.
 */

// "R$ 89,90", "R$89,9", "R$ 1.299,90", "R$ 90", "R$ 89.90"
const COM_CIFRAO = /R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:[,.](\d{1,2}))?/gi;
// "99 reais", "89,90 reais"
const COM_REAIS = /(\d{1,3}(?:\.\d{3})+|\d+)(?:[,.](\d{1,2}))?\s*reais\b/gi;

const emCentavos = (inteiro, fracao) => {
  const reais = Number(String(inteiro).replace(/\./g, ''));
  const centavos = fracao ? Number(String(fracao).padEnd(2, '0')) : 0;
  return reais * 100 + centavos;
};

/** Os valores em reais citados no texto, em centavos (sem repetir; R$ 0 não é preço). */
export function valoresEmCentavos(texto) {
  const achados = new Set();
  const fonte = String(texto ?? '');
  for (const regex of [COM_CIFRAO, COM_REAIS]) {
    for (const m of fonte.matchAll(regex)) {
      const valor = emCentavos(m[1], m[2]);
      if (valor > 0) achados.add(valor);
    }
  }
  return [...achados];
}

/** Os valores do texto que não estão na lista de permitidos (centavos). */
export function valoresForaDaLista(texto, permitidos) {
  const ok = permitidos instanceof Set ? permitidos : new Set(permitidos ?? []);
  return valoresEmCentavos(texto).filter((v) => !ok.has(v));
}

/** "R$ 89,90" a partir de centavos, para a nota da equipe. */
export const formatarReais = (centavos) => `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`;
