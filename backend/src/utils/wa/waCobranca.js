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
 * ─────────────────────────────────────────────────────────────────────────
 * EXCEÇÃO À REGRA 1 — variável OPCIONAL
 *
 * `link_messenger` não é dado da fatura: é um convite a conversar por outro
 * canal. Sem ele a cobrança continua perfeitamente válida, e recusá-la porque a
 * Página do Facebook está fora do ar, ou porque o contrato ainda não tem
 * cadastro, bloquearia dinheiro por causa de um extra. Por isso, vazia, ela NÃO
 * recusa: some junto com a LINHA em que está ("Prefere o Messenger? {{link}}"
 * sem o link seria texto solto). O modelo que tem a variável sozinha numa
 * mensagem, sem mais nada, continua recusando (ficaria vazio).
 *
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
  'link_boleto',
  'link_messenger'
]);

/**
 * As que, vazias, NÃO recusam a mensagem: a linha que as cita é que sai. Ver a
 * exceção à regra 1 no topo deste arquivo.
 */
export const VARIAVEIS_OPCIONAIS = Object.freeze(['link_messenger']);

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
    link_boleto: String(fatura?.link ?? '').trim(),
    // Preenchida por quem envia, com um link de uso único (`MessengerLinkTokenService`); aqui nasce vazia.
    link_messenger: ''
  };
}

/**
 * Os códigos de pagamento do modelo, tirados do texto para irem sozinhos.
 *
 * O cliente copia o PIX e a linha digitável com um toque quando cada código é
 * uma mensagem só dele. Se o modelo cita `{{pix}}` ou `{{linha_digitavel}}`, o
 * texto sai com `marcas` no lugar do código ("enviado a seguir") e os códigos
 * vão depois, nesta ordem: PIX, linha. Só se separa o que o modelo cita e a
 * fatura tem; sem citação nenhuma devolve `null` e o modelo sai como está.
 *
 * @param {string} modelo
 * @param {Record<string,string>} vars as de `variaveisDeCobranca`
 * @param {{ pix: string, linha_digitavel: string }} marcas
 * @returns {{ vars: Record<string,string>, extras: string[] }|null}
 */
export function separarCodigos(modelo, vars, marcas) {
  const citadas = new Set();
  String(modelo ?? '').replace(PLACEHOLDER, (_completo, chave) => {
    citadas.add(chave);
    return '';
  });
  const extras = [];
  const novas = { ...vars };
  for (const chave of ['pix', 'linha_digitavel']) {
    if (citadas.has(chave) && vars?.[chave]) {
      extras.push(String(vars[chave]));
      novas[chave] = marcas[chave];
    }
  }
  return extras.length ? { vars: novas, extras } : null;
}

/**
 * Preenche o modelo, ou recusa.
 *
 * @returns {string|null} `null` quando qualquer variável citada está vazia
 */
export function renderCobranca(modelo, vars) {
  const vazia = (chave) => {
    const v = vars?.[chave];
    return v === undefined || v === null || v === '';
  };
  // As linhas que citam uma variável opcional vazia saem inteiras; o resto do
  // texto segue pela regra 1.
  const linhas = String(modelo ?? '').split('\n');
  const mantidas = linhas.filter((linha) => {
    const citadas = [...linha.matchAll(PLACEHOLDER)].map((m) => m[1]);
    return !citadas.some((chave) => VARIAVEIS_OPCIONAIS.includes(chave) && vazia(chave));
  });
  const algumaSaiu = mantidas.length !== linhas.length;

  let faltou = false;
  let texto = mantidas.join('\n').replace(PLACEHOLDER, (_completo, chave) => {
    if (vazia(chave)) {
      faltou = true;
      return '';
    }
    return String(vars[chave]);
  });
  if (faltou) return null;
  if (algumaSaiu) {
    // Tira o buraco que a linha deixou (uma linha em branco sobrando) e as pontas.
    texto = texto.replace(/\n{3,}/g, '\n\n').trim();
    // O modelo era só a variável opcional: não sobra mensagem.
    if (!texto) return null;
  }
  return texto;
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

/**
 * Um modelo que cita os DOIS espelhos não rende para ninguém.
 *
 * Pela regra 1, uma variável citada e vazia recusa a mensagem inteira; pela
 * regra 2, `dias_atraso` e `dias_para_vencer` nunca estão preenchidas ao mesmo
 * tempo. Citar as duas é, portanto, um modelo que a régua sempre recusa —
 * silenciosamente, uma vez por destinatário, como `templateIncomplete`.
 *
 * Existe para que isso seja pego na hora de salvar, e não na contagem de
 * pulados de uma campanha que não saiu.
 */
export function modeloCitaOsDoisEspelhos(modelo) {
  const texto = String(modelo ?? '');
  return /\{\{\s*dias_atraso\s*\}\}/.test(texto) && modeloEhLembrete(texto);
}

/** O modelo pede o link do Messenger? Só então quem envia emite um (de uso único). */
export function modeloCitaLinkMessenger(modelo) {
  return /\{\{\s*link_messenger\s*\}\}/.test(String(modelo ?? ''));
}

/** As variáveis que o modelo cita e o disparo não sabe preencher. */
export function variaveisDesconhecidas(modelo) {
  const citadas = [...String(modelo ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]);
  return [...new Set(citadas)].filter((v) => !VARIAVEIS_DE_COBRANCA.includes(v));
}

/**
 * As variáveis que o modelo cita e que estão vazias — o porquê de um
 * `renderCobranca` que recusou. Na ordem em que aparecem, sem repetir.
 */
export function variaveisVazias(modelo, vars) {
  const citadas = [...String(modelo ?? '').matchAll(PLACEHOLDER)].map((m) => m[1]);
  return [...new Set(citadas)].filter((chave) => {
    // Uma opcional vazia não é o porquê de nenhuma recusa.
    if (VARIAVEIS_OPCIONAIS.includes(chave)) return false;
    const v = vars?.[chave];
    return v === undefined || v === null || v === '';
  });
}

/** A chave de uma fatura: o número do título, ou vencimento e valor. */
export function chaveDaFatura(fatura) {
  const id = String(fatura?.id ?? '').trim();
  if (id) return id.slice(0, 128);
  return `venc:${String(fatura?.dueDate ?? '').slice(0, 10)}:${fatura?.amount ?? ''}`.slice(0, 128);
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

/** A data de hoje (`AAAA-MM-DD`) no fuso do provedor. */
export function hojeNoFuso(now = new Date(), timezone = 'America/Sao_Paulo') {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/**
 * A situação pela data de vencimento da fatura em aberto mais antiga:
 * `ok` (em dia, ou ainda não venceu), `due_today` (vence hoje) ou `overdue`.
 * Sem fatura em aberto (`null`), em dia. Comparada com o dia de hoje no fuso
 * do provedor — às 23 h em São Paulo ainda é hoje, mesmo que em UTC não seja.
 *
 * @returns {{ status: 'ok'|'due_today'|'overdue', daysOverdue: number }}
 */
export function situacaoPorVencimento(oldestDueDate, now = new Date(), timezone = 'America/Sao_Paulo') {
  const venc = String(oldestDueDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(venc)) return { status: 'ok', daysOverdue: 0 };
  const hoje = hojeNoFuso(now, timezone);
  const dias = Math.round((Date.parse(`${hoje}T00:00:00Z`) - Date.parse(`${venc}T00:00:00Z`)) / 86_400_000);
  if (dias > 0) return { status: 'overdue', daysOverdue: dias };
  if (dias === 0) return { status: 'due_today', daysOverdue: 0 };
  return { status: 'ok', daysOverdue: 0 };
}

/** A situação de um contrato a partir das faturas em aberto que o SGP devolveu. */
export function situacaoFinanceira(faturas, now = new Date(), timezone = 'America/Sao_Paulo') {
  const abertas = (faturas || [])
    .filter((f) => f && !f.paid && /^\d{4}-\d{2}-\d{2}/.test(String(f.dueDate ?? '')))
    .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)));
  const oldestDueDate = abertas.length ? String(abertas[0].dueDate).slice(0, 10) : null;
  return { oldestDueDate, ...situacaoPorVencimento(oldestDueDate, now, timezone) };
}

/**
 * A fatura que o cliente recebe quando PEDE a fatura (menu do bot ou IA).
 *
 *  1. Há vencida (ou vencendo hoje): a mais antiga delas.
 *  2. Senão, a mais próxima a vencer, se faltam `dias` ou menos.
 *  3. Senão, nada — `proxima` é a que o cliente ainda não pode receber e
 *     `liberaEm` o dia (AAAA-MM-DD) em que passa a poder.
 *
 * O dia de vencimento conta como vencida, como em `diasEntre(..) >= 0` para o
 * resto do painel: quem pede a fatura no dia dela não é "adiantado".
 *
 * @returns {{ fatura: object|null, proxima: object|null, liberaEm: string|null }}
 */
export function faturaParaPedido(faturas, hoje = new Date(), dias = 5) {
  const abertas = (faturas || [])
    .filter((f) => f && !f.paid && f.dueDate && diasEntre(f.dueDate, hoje) !== null)
    .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  if (abertas.length === 0) return { fatura: null, proxima: null, liberaEm: null };

  const vencidas = abertas.filter((f) => diasEntre(f.dueDate, hoje) >= 0);
  if (vencidas.length > 0) return { fatura: vencidas[0], proxima: null, liberaEm: null };

  const proxima = abertas[0];
  const faltam = -diasEntre(proxima.dueDate, hoje);
  if (faltam <= dias) return { fatura: proxima, proxima: null, liberaEm: null };

  const venc = new Date(proxima.dueDate);
  const libera = new Date(Date.UTC(venc.getUTCFullYear(), venc.getUTCMonth(), venc.getUTCDate() - dias));
  return { fatura: null, proxima, liberaEm: libera.toISOString().slice(0, 10) };
}
