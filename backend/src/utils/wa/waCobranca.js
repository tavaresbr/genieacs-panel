/**
 * As variáveis de um modelo de cobrança, e a regra que decide se ele pode sair.
 *
 * Portado de compra-venda `supabase/functions/_shared/sgp-api.ts`. É o módulo
 * mais valioso do port inteiro, e o motivo cabe em duas regras:
 *
 * ─────────────────────────────────────────────────────────────────────────
 * REGRA 1 — variável vazia RECUSA a mensagem inteira
 *
 * `renderCobranca` devolve `null` quando qualquer `{{var}}` do modelo não tem
 * valor. Não substitui por vazio, não deixa o placeholder literal, não manda
 * "mais ou menos certo": recusa.
 *
 * O que isso evita: "PIX: {{pix}}" chegando a um inadimplente é pior que não
 * mandar nada — manda a pessoa pagar um placeholder. E um "R$ " sem valor faz o
 * cliente ligar para perguntar quanto é, o que custa mais que o silêncio.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * REGRA 2 — `dias_atraso` e `dias_para_vencer` são espelhos EXCLUDENTES
 *
 *   fatura vencida   →  dias_atraso = "12"   dias_para_vencer = ""
 *   fatura a vencer  →  dias_atraso = ""     dias_para_vencer = "7"
 *
 * Somado à regra 1, isso torna estruturalmente impossível um texto de cobrança
 * ("está em atraso há {{dias_atraso}} dias") chegar a quem ainda não venceu, e
 * um lembrete ("vence em {{dias_para_vencer}} dias") chegar a um inadimplente.
 *
 * A separação não depende de aviso na tela nem da disciplina de quem opera: é o
 * render que recusa. É por isso que `modeloEhLembrete()` pode simplesmente
 * perguntar se o texto cita `{{dias_para_vencer}}` para saber se o disparo pode
 * incluir faturas a vencer — o modelo se autodeclara.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Note que isto é o OPOSTO de um render de chat, que mantém o placeholder não
 * preenchido para o operador ver e completar. Ali há alguém olhando; aqui a
 * mensagem sai sozinha para centenas de pessoas.
 */

/** As únicas variáveis que o disparo sabe preencher. */
export const VARIAVEIS_DE_COBRANCA = Object.freeze([
  'nome',
  'valor',
  'vencimento',
  'dias_atraso',
  'dias_para_vencer',
  'pix',
  'linha_digitavel',
  'link_boleto'
]);

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][\w.-]*)\s*\}\}/g;

/** `1234.5` → `R$ 1.234,50`. Sem `Intl`: o formato é fixo e o locale não é. */
export function comoReal(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return '';
  const [inteiro, centavos] = Math.abs(n).toFixed(2).split('.');
  const milhar = inteiro.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}R$ ${milhar},${centavos}`;
}

/** ISO ou Date → `dd/mm/aaaa`. Vazio quando não dá para ler a data. */
export function comoDataBr(valor) {
  if (!valor) return '';
  const d = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  const dia = String(d.getUTCDate()).padStart(2, '0');
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dia}/${mes}/${d.getUTCFullYear()}`;
}

/**
 * Dias inteiros entre duas datas, em UTC.
 *
 * UTC de propósito: o vencimento é um dia do calendário, não um instante. Somar
 * fuso faria uma fatura que vence hoje aparecer como vencida ontem para quem
 * roda o painel a oeste de Greenwich.
 */
export function diasEntre(de, ate) {
  const a = de instanceof Date ? de : new Date(de);
  const b = ate instanceof Date ? ate : new Date(ate);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  const dia = 24 * 60 * 60 * 1000;
  const inicio = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate());
  const fim = Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate());
  return Math.round((fim - inicio) / dia);
}

/**
 * As variáveis de uma fatura, prontas para o render.
 *
 * @param {object} fatura no formato de `sgpService.normalizeInvoice`
 * @param {string} nome nome do cliente
 * @param {Date} [hoje] injetável para o teste
 * @returns {Record<string, string>}
 */
export function variaveisDeCobranca(fatura, nome, hoje = new Date()) {
  const atraso = fatura?.dueDate ? diasEntre(fatura.dueDate, hoje) : null;
  const vencida = atraso !== null && atraso > 0;

  return {
    nome: String(nome ?? '').trim(),
    valor: comoReal(fatura?.amount),
    vencimento: comoDataBr(fatura?.dueDate),
    // Os espelhos. Exatamente um dos dois tem valor, nunca os dois.
    dias_atraso: vencida ? String(atraso) : '',
    dias_para_vencer: atraso !== null && atraso <= 0 ? String(Math.abs(atraso)) : '',
    pix: String(fatura?.pix ?? '').trim(),
    linha_digitavel: String(fatura?.digitableLine ?? '').trim(),
    link_boleto: String(fatura?.link ?? '').trim()
  };
}

/**
 * Preenche o modelo, ou recusa.
 *
 * @returns {string|null} `null` quando qualquer variável citada está vazia
 */
export function renderCobranca(modelo, vars) {
  let faltou = false;
  const texto = String(modelo ?? '').replace(PLACEHOLDER, (_completo, chave) => {
    const v = vars?.[chave];
    if (v === undefined || v === null || v === '') {
      faltou = true;
      return '';
    }
    return String(v);
  });
  return faltou ? null : texto;
}

/**
 * Um modelo que cita `{{dias_para_vencer}}` É um lembrete.
 *
 * Não há campo de tipo em lugar nenhum, e não precisa haver: pela regra 2 esse
 * modelo só rende para fatura ainda não vencida, então citá-lo é a declaração.
 * Um campo separado poderia divergir do texto; isto não pode.
 */
export function modeloEhLembrete(modelo) {
  return /\{\{\s*dias_para_vencer\s*\}\}/.test(String(modelo ?? ''));
}

/** As variáveis que o modelo cita e o disparo não sabe preencher. */
export function variaveisDesconhecidas(modelo) {
  const citadas = [...String(modelo ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]);
  return [...new Set(citadas)].filter((v) => !VARIAVEIS_DE_COBRANCA.includes(v));
}

/**
 * A fatura que o disparo deve citar, entre as em aberto.
 *
 * A mais antiga vencida, porque é a que o cliente precisa resolver primeiro e a
 * que justifica a cobrança. Sem nenhuma vencida, devolve a próxima a vencer
 * apenas quando o modelo é um lembrete — para um texto de cobrança, "só tem
 * fatura a vencer" significa que não há o que cobrar, e `soFuturas` diz isso a
 * quem chama para que o motivo apareça na contagem de pulados.
 *
 * @returns {{ fatura: object|null, soFuturas: boolean }}
 */
export function maisAntigaEmAberto(faturas, hoje = new Date(), ehLembrete = false) {
  const abertas = (faturas || [])
    .filter((f) => f && !f.paid && f.dueDate)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  if (abertas.length === 0) return { fatura: null, soFuturas: false };

  const vencidas = abertas.filter((f) => diasEntre(f.dueDate, hoje) > 0);
  if (vencidas.length > 0) return { fatura: vencidas[0], soFuturas: false };

  return ehLembrete ? { fatura: abertas[0], soFuturas: false } : { fatura: null, soFuturas: true };
}
