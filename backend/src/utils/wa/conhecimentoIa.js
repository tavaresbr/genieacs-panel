/**
 * O pedido à IA para escrever a resposta de um item da base de conhecimento
 * (o botão "Sugerir resposta com IA" da tela). Só rascunho: o texto volta para a
 * caixa, e quem grava é o provedor, ao salvar o item.
 */

export const RESPOSTA_MAX = 600;

const TIPOS = {
  vantagem: 'uma VANTAGEM da empresa (algo de bom que o atendente virtual pode destacar ao conversar com quem ainda não é cliente)',
  objecao: 'uma OBJEÇÃO do cliente (uma resistência ou dúvida que ele costuma ter) e a melhor forma de responder a ela',
  faq: 'uma PERGUNTA frequente do cliente e a resposta a ela'
};

export function promptDeResposta({ empresa, tipo, informacoes }) {
  return [
    `Você ajuda o provedor de internet ${empresa} a preencher a base de conhecimento do atendente virtual de vendas, no WhatsApp.`,
    `O item é ${TIPOS[tipo] ?? TIPOS.faq}.`,
    'Escreva SÓ o texto-base da resposta, em português do Brasil, em até 3 frases curtas, tom simpático e direto, sem markdown, sem aspas e sem se apresentar.',
    'Regra principal: NÃO invente preço, prazo, desconto, cobertura, fidelidade, horário nem qualquer fato da empresa. Use só o que está nas informações da empresa abaixo. Onde faltar um fato, escreva um espaço a preencher entre colchetes, como [escreva o prazo real de instalação], para o dono da empresa completar.',
    informacoes ? `Informações da empresa (use como base):\n${informacoes}` : 'Não há informações cadastradas da empresa: use colchetes para todo fato.'
  ].join('\n');
}

export function pedidoDeResposta({ title, triggers, current }) {
  const linhas = [`Título do item: ${title}`];
  if (triggers) linhas.push(`Palavras que o cliente usa quando isso acontece: ${triggers}`);
  if (current) linhas.push(`Texto atual (melhore, mantendo os fatos que já estão nele):\n${current}`);
  else linhas.push('Ainda não há texto: escreva a primeira versão.');
  return linhas.join('\n');
}

/** O que voltou do modelo: sem cerca de código, aspas ou markdown, e no tamanho do campo. */
export function limparResposta(texto) {
  let t = String(texto ?? '').trim();
  t = t.replace(/^```[a-z]*\s*|\s*```$/gi, '').replace(/^["“”'`]+|["“”'`]+$/g, '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim();
  return t.slice(0, RESPOSTA_MAX);
}
