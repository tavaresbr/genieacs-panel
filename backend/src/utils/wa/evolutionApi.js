/**
 * Superfície HTTP do servidor Evolution — duas, na verdade.
 *
 * "Evolution" nomeia dois servidores diferentes: o **Evolution API v2**
 * (Node/Baileys) e o **Evolution GO** (whatsmeow, Gin). As duas APIs quase não
 * se sobrepõem, e o sistema de origem descobriu isso um HTTP 400 por vez —
 * `{"error":"name is required"}`, depois `{"error":"token is required"}`, e
 * finalmente `404 page not found` (o default do net/http do Go) em
 * `GET /instance/connect/{nome}`, rota que no GO é `POST /instance/connect` sem
 * segmento nenhum.
 *
 * As diferenças que importam:
 *
 *   ação            | Evolution v2                      | Evolution GO
 *   ----------------|-----------------------------------|---------------------------
 *   criar           | POST /instance/create             | POST /instance/create
 *                   | (qrcode, integration, webhook{})  | (instanceId, token,
 *                   |                                   |  advancedSettings{})
 *   webhook         | no corpo do create                | POST /instance/connect
 *   QR              | GET /instance/connect/{nome}      | GET /instance/qr
 *   estado          | GET /instance/connectionState/{n} | GET /instance/status
 *   sair            | DELETE /instance/logout/{nome}    | DELETE /instance/logout
 *   reiniciar       | POST /instance/restart/{nome}     | POST /instance/reconnect
 *   apagar          | DELETE /instance/delete/{nome}    | DELETE /instance/delete/{id}
 *   listar          | GET /instance/fetchInstances      | GET /instance/all
 *   texto           | POST /message/sendText/{nome}     | POST /send/text
 *   mídia           | POST /message/sendMedia/{nome}    | POST /send/media
 *   checar número   | POST /chat/whatsappNumbers/{nome} | POST /user/check
 *
 * Repare que quase nenhuma rota do GO carrega o nome da instância: ele
 * seleciona a instância pelo header `apikey`, comparando com o token daquela
 * instância. Só criar, listar e apagar usam a chave GLOBAL do servidor. Daí o
 * campo `key` em cada requisição: a rota diz qual credencial espera, em vez de
 * quem chama adivinhar.
 *
 * Este módulo é PURO de propósito — sem I/O, sem fetch — para que os testes
 * possam importá-lo direto e travar os formatos. Ele MONTA requisições; quem
 * faz HTTP é o chamador.
 *
 * Portado de compra-venda `supabase/functions/_shared/evolution-api.ts`.
 */

/**
 * @typedef {'go'|'v2'} EvoFlavor
 * @typedef {{ path: string, method: 'GET'|'POST'|'DELETE', body?: unknown, key: 'admin'|'instance' }} EvoRequest
 */

/**
 * Eventos que assinamos no Evolution GO.
 *
 * MESSAGE e SEND_MESSAGE cobrem recebida e enviada-por-outro-device; CONNECTION
 * traz Connected/PairSuccess/LoggedOut; QRCODE traz o QR novo a cada rotação
 * (~20 s) sem precisar de polling; READ_RECEIPT alimenta o status de entrega.
 * Nome inválido na lista é DESCARTADO em silêncio pelo servidor, então errar
 * aqui não dá erro — dá um canal mudo.
 */
export const GO_SUBSCRIBE_EVENTS = ['MESSAGE', 'SEND_MESSAGE', 'CONNECTION', 'QRCODE', 'READ_RECEIPT'];

/** Eventos do Evolution v2. */
export const V2_WEBHOOK_EVENTS = ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT', 'MESSAGES_UPDATE'];

const enc = encodeURIComponent;

// ────────────────────────────────────────────────────────────────────
// Detecção do sabor
// ────────────────────────────────────────────────────────────────────

/**
 * O GO expõe `GET /server/ok` → {"status":"ok"} sem autenticação. O v2 responde
 * a raiz com {version, clientName, ...}. Nenhum dos dois exige chave, então dá
 * para descobrir o sabor ANTES de tentar criar instância — que era como o
 * sistema de origem vinha descobrindo: no erro.
 *
 * @param {{ ok: boolean, data: unknown }} serverOk resposta de GET /server/ok
 * @param {{ ok: boolean, data: unknown }} root resposta de GET /
 * @returns {EvoFlavor}
 */
export function flavorFromProbes(serverOk, root) {
  const okData = serverOk?.data;
  if (serverOk?.ok && okData && typeof okData === 'object' && okData.status === 'ok') return 'go';
  const rootData = root?.data;
  if (root?.ok && rootData && typeof rootData === 'object' && typeof rootData.version === 'string') return 'v2';
  // Sem resposta conclusiva mantemos o comportamento histórico. Errar para 'go'
  // num servidor v2 quebraria quem já está conectado; errar para 'v2' num GO
  // devolve 404 legível, que é o que já sabemos diagnosticar.
  return 'v2';
}

// ────────────────────────────────────────────────────────────────────
// Licença do servidor
// ────────────────────────────────────────────────────────────────────

/**
 * Servidor sem licença ativa recusa TUDO, não só a rota chamada.
 *
 * Distribuições licenciadas respondem a cada requisição — inclusive
 * `/instance/all`, que é o health do painel — com HTTP 503 e
 * `{"code":"LICENSE_REQUIRED","error":"service not activated",
 *   "message":"License required...","register_url":"…/manager/login"}`.
 *
 * Sem reconhecer essa forma, o operador vê o JSON cru dentro de "o servidor
 * respondeu com erro" e vai conferir URL e chave — que estão certas. O problema
 * está numa licença que só se ativa no manager do servidor. Reconhecer aqui
 * transforma o despejo do corpo numa instrução.
 *
 * @returns {{ registerUrl: string|null }|null}
 */
export function readLicenseBlock(status, data) {
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const code = String(obj.code ?? '').trim().toUpperCase();

  // Duas portas de entrada. O código explícito vale em qualquer status — builds
  // diferentes devolvem 503, 402 ou 401 para a mesma condição. O texto só vale
  // junto de 503 para não rotular como licença um 500 qualquer que por acaso
  // mencione a palavra.
  const texto = typeof data === 'string'
    ? data
    : [obj.error, obj.message, obj.response].filter((v) => typeof v === 'string').join(' ');
  const porCodigo = code === 'LICENSE_REQUIRED';
  const porTexto = status === 503 && /licen[cs]/i.test(texto) && /(requir|activat|ativa|expir)/i.test(texto);
  if (!porCodigo && !porTexto) return null;

  // A URL vem do servidor, então passa por peneira antes de virar texto para o
  // operador: só http(s) e sem espaço, tamanho limitado. Ela nunca vira href.
  const bruta = String(obj.register_url ?? obj.registerUrl ?? '').trim();
  const registerUrl = /^https?:\/\/\S+$/i.test(bruta) && bruta.length <= 200 ? bruta : null;
  return { registerUrl };
}

// ────────────────────────────────────────────────────────────────────
// Instância
// ────────────────────────────────────────────────────────────────────

/**
 * @param {EvoFlavor} flavor
 * @param {{ name: string, token: string, instanceId?: string, webhookUrl: string, rejectCallMessage: string }} p
 *   `token` é o token da instância, gerado por nós — no GO é ele que seleciona
 *   a instância. `instanceId` é o UUID que escolhemos (GO); sem ele o servidor
 *   gera um e só saberíamos pela resposta. `webhookUrl` já vem com o segredo
 *   embutido (`?t=`).
 * @returns {EvoRequest}
 */
export function createInstanceRequest(flavor, p) {
  if (flavor === 'go') {
    return {
      path: '/instance/create',
      method: 'POST',
      key: 'admin',
      body: {
        // instanceId é aceito e usado como PK. Mandar o nosso torna o DELETE
        // possível mesmo que a resposta do create se perca — a rota de remoção
        // do GO é por id, não por nome.
        instanceId: p.instanceId,
        name: p.name,
        token: p.token,
        advancedSettings: {
          rejectCall: true,
          msgRejectCall: p.rejectCallMessage,
          ignoreGroups: true,
          ignoreStatus: true,
          // alwaysOnline FALSE de propósito, ao contrário do payload v2. Marcar
          // o device como sempre disponível faz o WhatsApp entregar a mensagem
          // nesta sessão e SUPRIMIR a notificação no celular do operador. Quem
          // atende pelo painel e pelo celular perderia os avisos do celular.
          alwaysOnline: false,
          // Marcar como lida é decisão de quem atende, não da integração: com
          // true o cliente vê o tique azul antes de alguém ter lido de fato.
          readMessages: false
        }
      }
    };
  }
  return {
    path: '/instance/create',
    method: 'POST',
    key: 'admin',
    body: {
      // Os dois nomes: versões novas do v2 exigem `name`, anteriores
      // `instanceName`. Propriedade desconhecida é tolerada.
      name: p.name,
      instanceName: p.name,
      token: p.token,
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
      rejectCall: true,
      msgCall: p.rejectCallMessage,
      groupsIgnore: true,
      alwaysOnline: true,
      webhook: {
        enabled: true,
        url: p.webhookUrl,
        // NÃO troque para true: com byEvents o servidor acrescenta o nome do
        // evento ao fim da URL, DEPOIS da query, e o `?t=` — que é como o
        // webhook autentica — para de ser lido como query.
        byEvents: false,
        base64: true,
        events: V2_WEBHOOK_EVENTS
      }
    }
  };
}

/**
 * No GO o webhook NÃO entra na criação: quem grava `instance.Webhook` e a lista
 * de eventos é o /instance/connect, que também é o que sobe o cliente whatsmeow
 * e começa a emitir QR. Sem esta chamada a instância existe e nunca conecta.
 *
 * Cuidado ao mexer: Connect() faz `instance.Webhook = data.WebhookUrl` sem
 * checar vazio — chamar sem webhookUrl APAGA o webhook já configurado.
 *
 * @returns {EvoRequest|null} null no v2, onde o webhook vai no create
 */
export function connectRequest(flavor, webhookUrl) {
  if (flavor !== 'go') return null;
  // Sem nome no caminho nem no corpo: a instância vem do header apikey.
  return {
    path: '/instance/connect',
    method: 'POST',
    key: 'instance',
    body: { immediate: true, webhookUrl, subscribe: GO_SUBSCRIBE_EVENTS }
  };
}

export function qrRequest(flavor, name) {
  return flavor === 'go'
    ? { path: '/instance/qr', method: 'GET', key: 'instance' }
    : { path: `/instance/connect/${enc(name)}`, method: 'GET', key: 'instance' };
}

export function statusRequest(flavor, name) {
  return flavor === 'go'
    ? { path: '/instance/status', method: 'GET', key: 'instance' }
    : { path: `/instance/connectionState/${enc(name)}`, method: 'GET', key: 'instance' };
}

export function logoutRequest(flavor, name) {
  return flavor === 'go'
    ? { path: '/instance/logout', method: 'DELETE', key: 'instance' }
    : { path: `/instance/logout/${enc(name)}`, method: 'DELETE', key: 'instance' };
}

export function reconnectRequest(flavor, name) {
  return flavor === 'go'
    ? { path: '/instance/reconnect', method: 'POST', key: 'instance' }
    : { path: `/instance/restart/${enc(name)}`, method: 'POST', key: 'instance' };
}

/**
 * No GO a remoção é por ID e exige a chave GLOBAL — não dá para apagar a
 * instância com o token dela. Quando não temos o id (linha antiga) ou a chave
 * admin, quem chama cai no logout e remove só a linha local.
 *
 * @returns {EvoRequest|null}
 */
export function deleteRequest(flavor, name, instanceId) {
  if (flavor === 'go') {
    if (!instanceId) return null;
    return { path: `/instance/delete/${enc(instanceId)}`, method: 'DELETE', key: 'admin' };
  }
  return { path: `/instance/delete/${enc(name)}`, method: 'DELETE', key: 'admin' };
}

export function listInstancesRequest(flavor) {
  return flavor === 'go'
    ? { path: '/instance/all', method: 'GET', key: 'admin' }
    : { path: '/instance/fetchInstances', method: 'GET', key: 'admin' };
}

// ────────────────────────────────────────────────────────────────────
// Mensagens
// ────────────────────────────────────────────────────────────────────

export function checkNumbersRequest(flavor, name, numbers) {
  return flavor === 'go'
    ? { path: '/user/check', method: 'POST', key: 'instance', body: { number: numbers } }
    : { path: `/chat/whatsappNumbers/${enc(name)}`, method: 'POST', key: 'instance', body: { numbers } };
}

/**
 * Foto de perfil do contato. Diferente das outras rotas de "mensagem", esta lê e
 * não escreve — ela existe para o painel deixar de identificar o cliente por um
 * círculo de iniciais.
 *
 * O GO não expõe rota equivalente: o whatsmeow tem GetProfilePictureInfo, mas o
 * servidor não a publica. Devolver null é mais honesto que inventar um caminho
 * que responderia 404.
 *
 * @returns {EvoRequest|null}
 */
export function fetchProfilePicRequest(flavor, name, number) {
  if (flavor === 'go') return null;
  return {
    path: `/chat/fetchProfilePictureUrl/${enc(name)}`,
    method: 'POST',
    key: 'instance',
    body: { number }
  };
}

export function sendTextRequest(flavor, name, number, text) {
  return flavor === 'go'
    ? { path: '/send/text', method: 'POST', key: 'instance', body: { number, text } }
    : { path: `/message/sendText/${enc(name)}`, method: 'POST', key: 'instance', body: { number, text } };
}

/**
 * Áudio de VOZ (PTT) — o balão com onda que toca sozinho no WhatsApp.
 *
 * Existe separado de `sendMediaRequest` porque são coisas diferentes do lado do
 * cliente: `sendMedia` com `mediatype: 'audio'` entrega um ARQUIVO anexado, que
 * o destinatário precisa baixar. Medido na conta real do sistema de origem: três
 * áudios gravados no painel saíram com ID do WhatsApp e chegaram como arquivo.
 *
 * DEVOLVE `null` NO SABOR 'go', DE PROPÓSITO: a rota de PTT do servidor GO não
 * foi medida, e chutar um caminho é o erro que já custou caro. `null` faz quem
 * chama seguir por `sendMediaRequest` — pior aparência, zero regressão.
 *
 * Quem chama TEM de tratar falha caindo para `sendMediaRequest`, e só em
 * resposta NÃO-2xx: repetir depois de um 2xx manda o áudio duas vezes.
 *
 * @returns {EvoRequest|null}
 */
export function sendAudioRequest(flavor, name, p) {
  if (flavor === 'go') return null;
  return {
    path: `/message/sendWhatsAppAudio/${enc(name)}`,
    method: 'POST',
    key: 'instance',
    body: { number: p.number, audio: p.url }
  };
}

/**
 * @param {EvoFlavor} flavor
 * @param {string} name
 * @param {{ number: string, type: string, url: string, caption: string, fileName: string }} p
 *   `type` é image | video | audio | document — o vocabulário é o mesmo nas duas
 *   APIs, mas os NOMES DOS CAMPOS não são.
 * @returns {EvoRequest}
 */
export function sendMediaRequest(flavor, name, p) {
  if (flavor === 'go') {
    return {
      path: '/send/media',
      method: 'POST',
      key: 'instance',
      // `filename` minúsculo e `url`/`type` no lugar de `media`/`mediatype`.
      body: { number: p.number, type: p.type, url: p.url, caption: p.caption, filename: p.fileName }
    };
  }
  return {
    path: `/message/sendMedia/${enc(name)}`,
    method: 'POST',
    key: 'instance',
    body: { number: p.number, mediatype: p.type, media: p.url, caption: p.caption, fileName: p.fileName }
  };
}

// ────────────────────────────────────────────────────────────────────
// Leitura das respostas
//
// O GO embrulha tudo em {message:"success", data:{...}}; o v2 devolve o objeto
// na raiz. Os leitores aceitam os dois formatos para que um servidor que fuja do
// padrão não derrube a ação inteira.
// ────────────────────────────────────────────────────────────────────

function unwrap(data) {
  const d = data ?? {};
  const inner = d.data;
  if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
  return d;
}

/** @returns {{ qr: string|null, code: string|null }} */
export function readQr(data) {
  const d = unwrap(data);
  // GO: {qrcode: "data:image/png;base64,...", code}
  // v2: {base64, code} — e algumas versões aninham em qrcode.base64.
  const nested = d.qrcode && typeof d.qrcode === 'object' ? d.qrcode : null;
  let qr = null;
  if (typeof d.qrcode === 'string') qr = d.qrcode;
  else if (typeof nested?.base64 === 'string') qr = nested.base64;
  else if (typeof d.base64 === 'string') qr = d.base64;
  return { qr, code: typeof d.code === 'string' ? d.code : null };
}

/**
 * @param {EvoFlavor} flavor
 * @returns {'connected'|'connecting'|'disconnected'|null}
 */
export function readStatus(flavor, data) {
  const d = unwrap(data);
  if (flavor === 'go') {
    // StatusStruct não tem tags json, então as chaves saem capitalizadas
    // (Connected/LoggedIn/Name) — exatamente como o Go nomeia os campos.
    const connected = d.Connected ?? d.connected;
    const loggedIn = d.LoggedIn ?? d.loggedIn;
    if (loggedIn && connected) return 'connected';
    if (connected) return 'connecting';
    return 'disconnected';
  }
  const nested = d.instance && typeof d.instance === 'object' ? d.instance : {};
  const state = String(d.state ?? nested.state ?? '');
  if (state === 'open') return 'connected';
  if (state === 'connecting') return 'connecting';
  if (state === 'close') return 'disconnected';
  return null;
}

/** Id da mensagem enviada, para casar o ACK que chega pelo webhook. */
export function readSentId(data) {
  const d = unwrap(data);
  // GO: data.Info.ID (types.MessageInfo, sem tags json).
  const info = d.Info && typeof d.Info === 'object' ? d.Info : null;
  if (typeof info?.ID === 'string' && info.ID) return info.ID;
  // v2: key.id, ou id na raiz.
  const key = d.key && typeof d.key === 'object' ? d.key : null;
  if (typeof key?.id === 'string' && key.id) return key.id;
  if (typeof d.id === 'string' && d.id) return d.id;
  return null;
}

/**
 * Só quatro campos saem daqui. A listagem do servidor devolve o `token` de cada
 * instância — a credencial que manda mensagens em nome do provedor — e ele NÃO
 * pode chegar ao navegador. Montar o objeto campo a campo garante isso melhor do
 * que lembrar de apagar a chave depois.
 *
 * @returns {{ name: string, status: string, owner: string, id: string }[]}
 */
export function readInstances(flavor, data) {
  const raw = data ?? {};
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (Array.isArray(raw.data)) arr = raw.data;
  const out = [];
  for (const item of arr) {
    const it = item ?? {};
    const nested = it.instance ?? {};
    const name = String(it.name ?? it.instanceName ?? nested.instanceName ?? nested.name ?? '');
    if (!name) continue;
    let status;
    if (flavor === 'go') {
      // O modelo do GO guarda um booleano `connected` e o motivo da última
      // queda; não há string de estado.
      status = it.connected ? 'open' : String(it.disconnect_reason || 'close');
    } else {
      status = String(it.connectionStatus ?? it.status ?? nested.connectionStatus ?? nested.status ?? 'unknown');
    }
    out.push({
      name,
      status,
      owner: String(it.jid ?? it.ownerJid ?? it.owner ?? nested.ownerJid ?? nested.owner ?? '').split('@')[0],
      id: String(it.id ?? nested.id ?? '')
    });
  }
  return out;
}

/**
 * URL da foto de perfil na resposta do fetchProfilePictureUrl.
 *
 * O v2 devolve {wuid, profilePictureUrl}; versões antigas usam `profilePicUrl`.
 * Contato sem foto, ou com foto restrita a contatos, responde com o campo nulo
 * ou ausente — isso NÃO é erro, é a resposta correta para "esta pessoa não te
 * mostra a foto".
 */
export function readProfilePicUrl(data) {
  const d = unwrap(data);
  for (const chave of ['profilePictureUrl', 'profilePicUrl']) {
    const v = d[chave];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** @returns {{ number: string, exists: boolean }[]} */
export function readNumberChecks(flavor, data) {
  if (flavor === 'go') {
    const d = unwrap(data);
    let users = [];
    if (Array.isArray(d.Users)) users = d.Users;
    else if (Array.isArray(d.users)) users = d.users;
    return users
      .map((u) => {
        const it = u ?? {};
        return {
          number: String(it.Query ?? it.query ?? '').replace(/\D/g, ''),
          exists: !!(it.IsInWhatsapp ?? it.isInWhatsapp)
        };
      })
      .filter((r) => r.number);
  }
  const arr = Array.isArray(data) ? data : [];
  return arr
    .map((u) => {
      const it = u ?? {};
      return { number: String(it.number ?? '').replace(/\D/g, ''), exists: !!it.exists };
    })
    .filter((r) => r.number);
}

// ────────────────────────────────────────────────────────────────────
// Webhook
// ────────────────────────────────────────────────────────────────────

/**
 * NENHUM dos dois servidores autentica o webhook por header por conta própria.
 *
 * O produtor do Evolution GO manda APENAS `Content-Type: application/json`. O v2
 * não é diferente no que importa: ele põe a chave da instância no CORPO do
 * evento (`apikey`, ao lado de `server_url`) e só envia header quando a
 * instância foi criada com `webhook.headers` preenchido. A crença de que "o v2
 * manda o header apikey" custou caro no sistema de origem: contra um servidor de
 * fábrica ela significa 401 em todo evento — sem QR, sem mensagem, sem sinal
 * algum fora do log do servidor.
 *
 * Por isso o segredo vai na URL nos DOIS sabores. Ele fica guardado no servidor
 * (instance.Webhook) e aparece nos logs das duas pontas — daí o segredo aqui NÃO
 * ser a chave da instância, e sim um token dedicado: vazar este permite forjar
 * evento de entrada; vazar aquele permitiria mandar mensagem em nome do provedor
 * e ler os contatos dele.
 *
 * Só funciona com `byEvents: false` no create do v2.
 */
export function webhookUrlWithToken(baseUrl, token) {
  const clean = String(baseUrl || '').replace(/[?#].*$/, '');
  return `${clean}?t=${enc(token)}`;
}
