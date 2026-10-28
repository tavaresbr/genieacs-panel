/**
 * O que mostrar no balão de uma mensagem que chegou sem texto e sem anexo.
 *
 * Sem isto o painel desenhava só "Anexo", e o atendente não tinha como saber
 * se o cliente reagiu com um 👍, mandou a localização, um contato ou uma foto
 * que não deu para baixar. Puro: recebe a mensagem já desembrulhada (sem
 * `ephemeralMessage` e afins) e devolve o texto, ou '' quando não reconhece.
 */

const TIPO_MIDIA = {
  imageMessage: '📷 Foto',
  videoMessage: '🎥 Vídeo',
  ptvMessage: '🎥 Vídeo',
  audioMessage: '🎤 Áudio',
  pttMessage: '🎤 Áudio',
  documentMessage: '📄 Documento',
  stickerMessage: '🏷️ Figurinha'
};

const texto = (valor) => (typeof valor === 'string' ? valor.trim() : '');

/** Os telefones de um vCard (`TEL;...:+55 93 9...`), sem repetição. */
function telefonesDoVcard(vcard) {
  const achados = [];
  for (const linha of String(vcard || '').split(/\r?\n/)) {
    const m = linha.match(/^(?:item\d+\.)?TEL[^:]*:(.+)$/i);
    if (m && texto(m[1]) && !achados.includes(texto(m[1]))) achados.push(texto(m[1]));
  }
  return achados;
}

function contato(no) {
  const nome = texto(no?.displayName) || 'sem nome';
  const telefones = telefonesDoVcard(no?.vcard);
  return telefones.length ? `${nome} — ${telefones.join(', ')}` : nome;
}

function localizacao(no) {
  const lat = Number(no?.degreesLatitude);
  const lng = Number(no?.degreesLongitude);
  const nome = [texto(no?.name), texto(no?.address)].filter(Boolean).join(' — ');
  const link = Number.isFinite(lat) && Number.isFinite(lng)
    ? `https://www.google.com/maps?q=${lat},${lng}`
    : '';
  return ['📍 Localização', nome, link].filter(Boolean).join('\n');
}

/** Um item por linha, cortado: o payload vem de fora e uma lista não é um arquivo. */
const linhas = (itens, teto = 10) => itens.map(texto).filter(Boolean).slice(0, teto).map((item) => `• ${item}`);

/** O nome de um botão de fluxo nativo (`buttonParamsJson` é um JSON em texto). */
function nomeDoBotaoNativo(botao) {
  try {
    const dados = JSON.parse(botao?.buttonParamsJson || '{}');
    return texto(dados.display_text) || texto(dados.title) || texto(botao?.name);
  } catch {
    return texto(botao?.name);
  }
}

/**
 * Mensagens que o remetente monta com texto e botões: o menu de um robô de
 * atendimento, um aviso com "Ver fatura". O atendente lê o texto e a lista das
 * opções, que é o que o cliente via no celular. Devolve '' se não é uma delas.
 */
function estruturada(mensagem) {
  const botoes = mensagem.buttonsMessage;
  if (botoes && typeof botoes === 'object') {
    const opcoes = Array.isArray(botoes.buttons) ? botoes.buttons.map((b) => b?.buttonText?.displayText) : [];
    return [texto(botoes.contentText) || texto(botoes.text), ...linhas(opcoes), texto(botoes.footerText)].filter(Boolean).join('\n');
  }

  const lista = mensagem.listMessage;
  if (lista && typeof lista === 'object') {
    const secoes = Array.isArray(lista.sections) ? lista.sections : [];
    const opcoes = secoes.flatMap((secao) => (Array.isArray(secao?.rows) ? secao.rows.map((linha) => linha?.title) : []));
    return [texto(lista.title), texto(lista.description), ...linhas(opcoes), texto(lista.footerText)].filter(Boolean).join('\n');
  }

  const modelo = mensagem.templateMessage
    ? (mensagem.templateMessage.hydratedTemplate || mensagem.templateMessage.hydratedFourRowTemplate || mensagem.templateMessage.fourRowTemplate)
    : mensagem.highlyStructuredMessage?.hydratedHsm?.hydratedTemplate;
  if (modelo && typeof modelo === 'object') {
    const opcoes = Array.isArray(modelo.hydratedButtons)
      ? modelo.hydratedButtons.map((b) => b?.quickReplyButton?.displayText || b?.urlButton?.displayText || b?.callButton?.displayText)
      : [];
    return [texto(modelo.hydratedTitleText), texto(modelo.hydratedContentText), ...linhas(opcoes), texto(modelo.hydratedFooterText)]
      .filter(Boolean).join('\n');
  }

  const interativa = mensagem.interactiveMessage;
  if (interativa && typeof interativa === 'object') {
    const botoesNativos = Array.isArray(interativa.nativeFlowMessage?.buttons) ? interativa.nativeFlowMessage.buttons : [];
    return [texto(interativa.header?.title), texto(interativa.body?.text), ...linhas(botoesNativos.map(nomeDoBotaoNativo)), texto(interativa.footer?.text)]
      .filter(Boolean).join('\n');
  }

  const convite = mensagem.groupInviteMessage;
  if (convite && typeof convite === 'object') return `👥 Convite para o grupo ${texto(convite.groupName) || 'sem nome'}`;
  if (mensagem.orderMessage && typeof mensagem.orderMessage === 'object') {
    return `🛒 Pedido${texto(mensagem.orderMessage.orderTitle) ? `: ${texto(mensagem.orderMessage.orderTitle)}` : ''}`;
  }
  const produto = mensagem.productMessage?.product;
  if (produto && typeof produto === 'object') return `🛍️ Produto: ${texto(produto.title) || 'sem título'}`;
  return '';
}

/** Chaves que acompanham toda mensagem e não dizem o que ela é. */
const SO_CONTEXTO = new Set(['messageContextInfo', 'senderKeyDistributionMessage', 'contextInfo']);


/**
 * @param {object|null} mensagem a mensagem já desembrulhada
 */
export function resumoSemTexto(mensagem) {
  if (!mensagem || typeof mensagem !== 'object') return '';

  const reacao = mensagem.reactionMessage;
  if (reacao && typeof reacao === 'object') {
    const emoji = texto(reacao.text);
    return emoji ? `Reagiu com ${emoji} a uma mensagem` : 'Removeu a reação a uma mensagem';
  }

  const local = mensagem.locationMessage || mensagem.liveLocationMessage;
  if (local && typeof local === 'object') return localizacao(local);

  if (mensagem.contactMessage && typeof mensagem.contactMessage === 'object') {
    return `👤 Contato: ${contato(mensagem.contactMessage)}`;
  }
  const lista = mensagem.contactsArrayMessage?.contacts;
  if (Array.isArray(lista) && lista.length) {
    return `👤 Contatos:\n${lista.slice(0, 10).map(contato).join('\n')}`;
  }

  const enquete = mensagem.pollCreationMessage || mensagem.pollCreationMessageV2 || mensagem.pollCreationMessageV3;
  if (enquete && typeof enquete === 'object') {
    const opcoes = Array.isArray(enquete.options) ? enquete.options.map((o) => texto(o?.optionName)).filter(Boolean) : [];
    return [`📊 Enquete: ${texto(enquete.name) || 'sem título'}`, ...opcoes.map((o) => `• ${o}`)].join('\n');
  }
  if (mensagem.pollUpdateMessage) return '📊 Votou numa enquete';

  // Era mídia, mas os bytes não chegaram (o servidor não entregou, o arquivo
  // expirou): o atendente fica sabendo o que era e que precisa pedir de novo.
  for (const [no, rotulo] of Object.entries(TIPO_MIDIA)) {
    if (mensagem[no] && typeof mensagem[no] === 'object') {
      const nome = texto(mensagem[no].fileName);
      return `${rotulo}${nome ? ` (${nome})` : ''} — não foi possível baixar o arquivo. Peça ao cliente para enviar de novo.`;
    }
  }

  const montada = estruturada(mensagem);
  if (montada) return montada;

  // O cliente apagou uma mensagem para todos.
  const protocolo = mensagem.protocolMessage;
  if (protocolo && typeof protocolo === 'object' && (protocolo.type === 0 || protocolo.type === 'REVOKE')) {
    return '🚫 Apagou uma mensagem';
  }

  // Nenhum tipo conhecido: diz qual foi, para o atendente saber que há algo no
  // celular e para quem mantém o painel saber o que falta mostrar.
  const tipo = Object.keys(mensagem).find((chave) => !SO_CONTEXTO.has(chave) && mensagem[chave] && typeof mensagem[chave] === 'object');
  return tipo ? `❔ Mensagem do tipo ${tipo.replace(/[^\w]/g, '').slice(0, 48)}, que o painel não exibe. Veja no celular.` : '';
}
