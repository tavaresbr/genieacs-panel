/**
 * A base de conhecimento da IA de vendas: o que entra na conversa e quando.
 *
 * Sem embeddings: cada item de objeção ou pergunta traz as palavras que o
 * ativam (`triggers`), e entra se alguma aparece no que o cliente escreveu.
 * As vantagens entram sempre. O tamanho é limitado, para a base crescer sem
 * pesar no pedido: o que não cabe fica de fora, e os itens que combinam com a
 * conversa vêm antes das vantagens.
 */

export const TIPOS_DE_CONHECIMENTO = Object.freeze(['vantagem', 'objecao', 'faq']);
export const LIMITE_DO_PROMPT = 1500;
export const LUGARES_MAX = 100;
const LUGAR_MAX = 80;

const ROTULO = { vantagem: 'Vantagem', objecao: 'Objeção', faq: 'Pergunta' };

/** Minúsculas, sem acento, espaços simples: "Não  Está" → "nao esta". */
export const normalizar = (texto) => String(texto ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

/** "caro, preço alto" → ["caro", "preco alto"]; até 20 palavras de 2+ letras. */
export function lerGatilhos(texto) {
  const vistos = new Set();
  for (const parte of String(texto ?? '').split(',')) {
    const gatilho = normalizar(parte);
    if (gatilho.length >= 2) vistos.add(gatilho);
  }
  return [...vistos].slice(0, 20);
}

/** O item combina com a conversa se algum gatilho aparece nela. */
export const combina = (item, conversaNormalizada) => lerGatilhos(item.triggers).some((g) => conversaNormalizada.includes(g));

const linha = (item) => `- ${ROTULO[item.kind] ?? 'Item'} — ${item.title}: ${item.answer}`;

/**
 * @param {Array<{kind,title,triggers,answer,active}>} itens
 * @param {string} conversa o que o cliente escreveu (as últimas mensagens)
 * @returns {{ itens: Array, texto: string, usados: Array }} `usados` = os que entraram por gatilho
 */
export function escolherConhecimento(itens, conversa, limite = LIMITE_DO_PROMPT) {
  const ativos = (itens ?? []).filter((i) => i.active);
  const alvo = normalizar(conversa);
  const porGatilho = ativos.filter((i) => i.kind !== 'vantagem' && combina(i, alvo));
  const vantagens = ativos.filter((i) => i.kind === 'vantagem');
  const escolhidos = [];
  let tamanho = 0;
  for (const item of [...porGatilho, ...vantagens]) {
    const texto = linha(item);
    if (tamanho + texto.length + 1 > limite) continue;
    escolhidos.push(item);
    tamanho += texto.length + 1;
  }
  const texto = escolhidos.length
    ? `Base de conhecimento da empresa (use como base, com suas próprias palavras; não invente nada além disso):\n${escolhidos.map(linha).join('\n')}`
    : '';
  return { itens: escolhidos, texto, usados: escolhidos.filter((i) => porGatilho.includes(i)) };
}

/** Um lugar da cobertura como texto para a IA: "Itaituba (também: Itaitu, ITB)". */
const lugarEmTexto = (lugar) => {
  const { name, aliases } = typeof lugar === 'string' ? { name: lugar, aliases: [] } : lugar;
  return aliases?.length ? `${name} (também: ${aliases.join(', ')})` : name;
};

/** A regra de cobertura; vazia quando o provedor não cadastrou lugares. Aceita `{name, aliases}` ou texto. */
export function blocoCobertura(lugares) {
  const lista = (lugares ?? []).filter((l) => (typeof l === 'string' ? l : l?.name));
  if (!lista.length) return '';
  return `Lugares atendidos pela empresa: ${lista.map(lugarEmTexto).join(', ')}. Se a pessoa citar uma cidade ou bairro que NÃO está nesta lista (nem entre os nomes "também"), não confirme nem negue a cobertura: diga que vai conferir e use transferir_para_atendente. Se o lugar está na lista, pode confirmar que atende.`;
}

/** A lista de lugares do formulário: texto limpo, sem repetido (sem ligar para caixa), no limite. */
export function limparLugares(valor) {
  if (!Array.isArray(valor)) return null;
  const vistos = new Set();
  const lista = [];
  for (const bruto of valor) {
    const nome = String(bruto ?? '').replace(/\s+/g, ' ').trim().slice(0, LUGAR_MAX);
    const chave = normalizar(nome);
    if (!nome || vistos.has(chave)) continue;
    vistos.add(chave);
    lista.push(nome);
    if (lista.length >= LUGARES_MAX) break;
  }
  return lista;
}

/** Itens de exemplo: nascem desativados e só valem depois de editados. */
export const EXEMPLOS = Object.freeze([
  { kind: 'vantagem', title: 'Suporte', triggers: '', answer: 'Descreva aqui como é o seu suporte: canais, horário e em quanto tempo atendem.' },
  { kind: 'vantagem', title: 'Qualidade da rede', triggers: '', answer: 'Descreva aqui o que sua rede tem de melhor: fibra até a casa, monitoramento, estabilidade.' },
  { kind: 'vantagem', title: 'Jeito de atender', triggers: '', answer: 'Descreva aqui o que o cliente ganha por ser atendido por um provedor local.' },
  { kind: 'objecao', title: 'Acha caro', triggers: 'caro, preço alto, mais barato, muito pago', answer: 'Mostre o que o plano inclui (equipamento, suporte, estabilidade) e ofereça o plano que cabe no bolso dele.' },
  { kind: 'objecao', title: 'A internet cai', triggers: 'cai, caindo, instável, instavel, lenta, lento', answer: 'Explique como sua rede evita quedas e como o cliente é avisado quando acontece algo.' },
  { kind: 'objecao', title: 'Já tenho internet', triggers: 'já tenho, ja tenho, outro provedor, concorrente, operadora', answer: 'Sem pressão: pergunte o que ele paga e o que o incomoda hoje, e compare com o que você oferece.' },
  { kind: 'objecao', title: 'Vou pensar', triggers: 'vou pensar, depois, mais tarde', answer: 'Agradeça, deixe a porta aberta e ofereça mandar as informações para ele ver com calma.' },
  { kind: 'faq', title: 'Tem fidelidade?', triggers: 'fidelidade, multa, contrato, cancelar', answer: 'Escreva aqui a sua regra real de fidelidade e de cancelamento.' }
]);

const APELIDOS_MAX = 10;

/**
 * A cobertura do formulário: `{ name, aliases[] }` por lugar. Aceita também o
 * formato antigo (só o texto do nome). Sem repetir nome (sem ligar para caixa
 * ou acento), sem apelido igual ao nome ou ao de outro lugar, nos limites.
 *
 * @returns {{name: string, aliases: string[]}[]|null} `null` se não for lista
 */
export function limparCobertura(valor) {
  if (!Array.isArray(valor)) return null;
  const nomes = [];
  for (const bruto of valor) {
    const origem = typeof bruto === 'object' && bruto !== null ? bruto : { name: bruto };
    const name = String(origem.name ?? '').replace(/\s+/g, ' ').trim().slice(0, LUGAR_MAX);
    if (name) nomes.push({ name, aliases: Array.isArray(origem.aliases) ? origem.aliases : [] });
  }
  // Os nomes valem primeiro: um apelido nunca toma o lugar do nome de outro.
  const usados = new Set();
  const lugares = [];
  for (const { name, aliases } of nomes) {
    const chave = normalizar(name);
    if (usados.has(chave)) continue;
    usados.add(chave);
    lugares.push({ name, aliases });
    if (lugares.length >= LUGARES_MAX) break;
  }
  return lugares.map(({ name, aliases }) => {
    const proprios = [];
    for (const bruto of aliases) {
      const apelido = String(bruto ?? '').replace(/\s+/g, ' ').trim().slice(0, LUGAR_MAX);
      const chave = normalizar(apelido);
      if (!apelido || usados.has(chave)) continue;
      usados.add(chave);
      proprios.push(apelido);
      if (proprios.length >= APELIDOS_MAX) break;
    }
    return { name, aliases: proprios };
  });
}

/** O nome do lugar e os apelidos: tudo o que o cliente pode escrever para se referir a ele. */
export const nomesDoLugar = (lugar) => (typeof lugar === 'string' ? [lugar] : [lugar.name, ...(lugar.aliases ?? [])]);
