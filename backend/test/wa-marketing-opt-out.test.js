import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, authHeaders, call, getDb, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaConversation } = await import('../src/models/WaConversation.js');
const { default: WaMessage } = await import('../src/models/WaMessage.js');
const { default: WaOptOut } = await import('../src/models/WaOptOut.js');
const { default: WaMarketingOptOut } = await import('../src/models/WaMarketingOptOut.js');
const { default: WaBroadcast } = await import('../src/models/WaBroadcast.js');
const { default: WaBroadcastService } = await import('../src/services/waBroadcastService.js');
const { default: WaBillingService } = await import('../src/services/waBillingService.js');
const { default: WaSendService } = await import('../src/services/waSendService.js');
const { isPermanentFailure } = await import('../src/services/waSendFailure.js');
const { default: WaMarketingOptOutService, classificarPedido, DEFAULT_CONFIG } = await import('../src/services/waMarketingOptOutService.js');

/**
 * "Não quero promoção": o cliente manda "parar" (ou toca no botão "Parar
 * promoções" da Meta) e só o que é promoção deixa de sair — modelo da Meta de
 * MARKETING e campanha marcada como promocional. Cobrança e aviso continuam.
 */

const INSTANCE = 'painel-promo';
const WEBHOOK_TOKEN = 'token-webhook-promo';
const FONE = { a: '5593991120301', b: '5593991120302', c: '5593991120303' };

let panelUrl;
let token;
let accountId;
const api = (rota, options = {}) => call(`${panelUrl}/api/whatsapp${rota}`, { headers: authHeaders(token), ...options });
const hook = (body) => call(`${panelUrl}/api/whatsapp-webhook?t=${WEBHOOK_TOKEN}`, { method: 'POST', body });

let seq = 0;
/** Um `messages.upsert` do v2. `messageType` diz se é resposta de botão. */
function recebida(fone, texto, { fromMe = false, messageType = 'conversation', message = null } = {}) {
  seq += 1;
  return {
    event: 'messages.upsert',
    instance: INSTANCE,
    data: {
      key: { remoteJid: `${fone}@s.whatsapp.net`, fromMe, id: `PROMO-${seq}` },
      pushName: 'Cliente',
      message: message ?? { conversation: texto },
      messageType,
      messageTimestamp: 1739990000
    }
  };
}

const ativos = () => getDb()('wa_marketing_opt_outs').whereNull('revoked_at');
const respostasDoBot = (fone) => getDb()('wa_messages')
  .join('wa_conversations', 'wa_conversations.id', 'wa_messages.conversation_id')
  .where({ 'wa_conversations.wa_phone_e164': fone, 'wa_messages.direction': 'out', 'wa_messages.source': 'bot' })
  .select('wa_messages.body');

async function conversaDe(fone) {
  return asTenant(() => WaConversation.ensure({
    accountId,
    externalThreadId: `${fone}@s.whatsapp.net`,
    waPhone: fone
  }));
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  const setup = await call(`${panelUrl}/api/auth/setup`, {
    method: 'POST',
    body: { username: 'operator', password: 'operator-password-1', email: 'operator@exemplo.test' }
  });
  token = setup.body.data.token;
  await asTenant(() => WhatsAppConfigService.saveConfig({
    enabled: true, webhookBaseUrl: 'https://painel.provedor.test/api/whatsapp-webhook', rateLimitPerMin: 60
  }));
  const account = await asTenant(() => WhatsAppAccount.create({
    name: INSTANCE,
    purpose: 'billing',
    flavor: 'v2',
    base_url: 'https://evo.provedor.test',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-instancia-promo'),
    ...WhatsAppConfigService.encryptWebhookToken(WEBHOOK_TOKEN)
  }));
  accountId = account.id;
  // Dois modelos aprovados na Meta: um de promoção, um de cobrança.
  await getDb()('wa_meta_templates').insert([
    { tenant_id: 1, account_id: accountId, name: 'promo_do_mes', language: 'pt_BR', category: 'MARKETING', status: 'APPROVED', body_text: 'Oferta {{1}}', param_count: 1, supported: true },
    { tenant_id: 1, account_id: accountId, name: 'aviso_fatura', language: 'pt_BR', category: 'UTILITY', status: 'APPROVED', body_text: 'Fatura {{1}}', param_count: 1, supported: true }
  ]);
  await getDb()('sgp_contacts').insert([
    ['401', 'ANA PROMO', FONE.a],
    ['402', 'BRUNO LIVRE', FONE.b]
  ].map(([contract, name, phone]) => ({ tenant_id: 1, contract, client_name: name, phone_e164: phone, state: 'active' })));
});

after(async () => {
  await stopTestServers();
});

beforeEach(async () => {
  await getDb()('wa_marketing_opt_outs').del();
  await getDb()('wa_opt_outs').del();
  await getDb()('wa_messages').del();
  await getDb()('app_state').where({ key: 'wa_marketing_opt_out_config' }).del();
  asTenant(() => WaBillingService.resetBuildWindow());
});

describe('o que conta como pedido', () => {
  it('só a mensagem inteira, sem acento, caixa nem pontuação', () => {
    assert.deepEqual(classificarPedido('PARAR!'), { acao: 'stop', source: 'keyword' });
    assert.deepEqual(classificarPedido('  Não quero receber.  '), { acao: 'stop', source: 'keyword' });
    assert.deepEqual(classificarPedido('Cancelar promoções'), { acao: 'stop', source: 'keyword' });
    assert.deepEqual(classificarPedido('stop'), { acao: 'stop', source: 'keyword' });
    assert.deepEqual(classificarPedido('Voltar'), { acao: 'resume', source: 'keyword' });
    assert.deepEqual(classificarPedido('START'), { acao: 'resume', source: 'keyword' });
    // Frase longa que só contém a palavra: conversa, não pedido.
    assert.equal(classificarPedido('vou parar no caminho e passo aí'), null);
    assert.equal(classificarPedido('não quero receber visita técnica amanhã'), null);
    assert.equal(classificarPedido('Então pode separar'), null);
    assert.equal(classificarPedido(''), null);
  });

  it('o botão "Parar promoções" da Meta vale mesmo fora da lista do provedor', () => {
    const semLista = { ...DEFAULT_CONFIG, stopWords: [] };
    assert.deepEqual(classificarPedido('Parar promoções', semLista, { botao: true }), { acao: 'stop', source: 'button' });
    assert.deepEqual(classificarPedido('Stop promotions', semLista, { botao: true }), { acao: 'stop', source: 'button' });
    // Digitado, sem lista, não é pedido.
    assert.equal(classificarPedido('Parar promoções', semLista), null);
    // Outro botão qualquer (o "Já paguei" de um modelo de cobrança) não é.
    assert.equal(classificarPedido('Já paguei', semLista, { botao: true }), null);
  });

  it('a lista é do provedor', () => {
    const propria = { ...DEFAULT_CONFIG, stopWords: ['chega'], resumeWords: ['pode mandar'] };
    assert.deepEqual(classificarPedido('Chega!', propria), { acao: 'stop', source: 'keyword' });
    assert.equal(classificarPedido('parar', propria), null);
    assert.deepEqual(classificarPedido('pode mandar', propria), { acao: 'resume', source: 'keyword' });
  });
});

describe('o pedido que chega pelo WhatsApp', () => {
  it('"parar" grava, responde UMA vez e a repetição não responde de novo', async () => {
    assert.equal((await hook(recebida(FONE.a, 'Parar'))).status, 200);
    const [linha] = await ativos();
    assert.equal(linha.wa_phone_e164, FONE.a);
    assert.equal(linha.source, 'keyword');
    assert.equal(linha.trigger_text, 'Parar');

    let bot = await respostasDoBot(FONE.a);
    assert.equal(bot.length, 1, 'uma confirmação');
    assert.equal(bot[0].body, DEFAULT_CONFIG.confirmText);
    assert.match(bot[0].body, /VOLTAR/);

    await hook(recebida(FONE.a, 'PARAR!!'));
    assert.equal((await ativos()).length, 1, 'continua uma linha só');
    bot = await respostasDoBot(FONE.a);
    assert.equal(bot.length, 1, 'e nenhuma resposta a mais');
  });

  it('o botão da Meta chega como resposta de botão e é gravado como botão', async () => {
    // O Evolution da API oficial converte o `button` da Meta em `conversation`
    // e marca o tipo da mensagem.
    await hook(recebida(FONE.b, 'Parar promoções', { messageType: 'buttonMessage' }));
    const [linha] = await ativos();
    assert.equal(linha.source, 'button');
    // E o formato cru da Meta, se o servidor o repassar sem converter.
    await getDb()('wa_marketing_opt_outs').del();
    await hook(recebida(FONE.b, '', { messageType: 'button', message: { button: { text: 'Stop promotions', payload: 'STOP' } } }));
    assert.equal((await ativos())[0].source, 'button');
    // Botão não é palavra de "SAIR": o não perturbe inteiro não é gravado.
    assert.equal(await asTenant(() => WaOptOut.isActive({ waPhone: FONE.b })), false);
  });

  it('frase longa e eco do próprio provedor não tiram ninguém', async () => {
    await hook(recebida(FONE.c, 'vou parar de usar o wifi do vizinho'));
    await hook(recebida(FONE.c, 'parar', { fromMe: true }));
    assert.equal((await ativos()).length, 0);
  });

  it('"VOLTAR" desfaz o pedido e responde; de quem nunca saiu, não faz nada', async () => {
    await hook(recebida(FONE.c, 'voltar'));
    assert.equal((await respostasDoBot(FONE.c)).filter((m) => m.body === DEFAULT_CONFIG.resumeText).length, 0);

    // "sair" grava o não perturbe inteiro (o de sempre) e também o de promoção.
    await hook(recebida(FONE.c, 'sair'));
    assert.equal((await ativos()).length, 1);
    assert.equal(await asTenant(() => WaOptOut.isActive({ waPhone: FONE.c })), true);

    await hook(recebida(FONE.c, 'VOLTAR'));
    assert.equal((await ativos()).length, 0);
    const [revogada] = await getDb()('wa_marketing_opt_outs').where({ wa_phone_e164: FONE.c });
    assert.equal(revogada.revoked_source, 'keyword');
    // O "SAIR" foi do cliente; a volta dele desfaz os dois.
    assert.equal(await asTenant(() => WaOptOut.isActive({ waPhone: FONE.c })), false);
    const bot = (await respostasDoBot(FONE.c)).map((m) => m.body);
    assert.ok(bot.includes(DEFAULT_CONFIG.resumeText));
  });

  it('desligado na configuração, "parar" não grava o pedido de promoção', async () => {
    await asTenant(() => WaMarketingOptOutService.saveConfig({ enabled: false }));
    await hook(recebida(FONE.a, 'parar promoções'));
    assert.equal((await ativos()).length, 0);
  });
});

describe('o bloqueio no envio', () => {
  it('modelo de MARKETING não sai para quem pediu; UTILITY e texto comum saem', async () => {
    const conversa = await conversaDe(FONE.a);
    await asTenant(() => WaMarketingOptOut.record({ waPhone: FONE.a, source: 'keyword' }));

    await assert.rejects(
      asTenant(() => WaSendService.enqueue({
        conversationId: conversa.id,
        source: 'campaign',
        metaTemplate: { name: 'promo_do_mes', language: 'pt_BR', params: ['10%'] }
      })),
      (error) => error.code === 'marketing_opt_out' && error.status === 409
    );
    // Texto livre marcado como promoção, idem — inclusive pelo operador.
    await assert.rejects(
      asTenant(() => WaSendService.enqueue({ conversationId: conversa.id, body: 'Promoção!', source: 'operator', marketing: true })),
      (error) => error.code === 'marketing_opt_out'
    );

    const fatura = await asTenant(() => WaSendService.enqueue({
      conversationId: conversa.id,
      source: 'campaign',
      metaTemplate: { name: 'aviso_fatura', language: 'pt_BR', params: ['R$ 99'] }
    }));
    assert.equal(fatura.delivery_status, 'queued');
    assert.ok(!fatura.marketing);
    const resposta = await asTenant(() => WaSendService.enqueue({ conversationId: conversa.id, body: 'Sua internet voltou', source: 'operator' }));
    assert.equal(resposta.delivery_status, 'queued');
  });

  it('a promoção já na fila não sai se o pedido chegou depois', async () => {
    const conversa = await conversaDe(FONE.b);
    const promo = await asTenant(() => WaSendService.enqueue({ conversationId: conversa.id, body: 'Oferta', source: 'campaign', marketing: true }));
    assert.ok(promo.marketing, 'marcada como promoção na fila');
    await asTenant(() => WaMarketingOptOut.record({ waPhone: FONE.b, source: 'button' }));
    const linha = await asTenant(() => WaMessage.getById(promo.id));
    let erro = null;
    try {
      await asTenant(() => WaSendService.dispatch(linha));
    } catch (error) {
      erro = error;
    }
    assert.equal(erro?.code, 'marketing_opt_out');
    assert.equal(isPermanentFailure(erro), true, 'tentar de novo não muda o pedido');
  });

  it('a campanha pula com o motivo marketing_opt_out só o que é promoção', async () => {
    await asTenant(() => WaMarketingOptOut.record({ waPhone: FONE.a, source: 'keyword' }));

    const enviar = async ({ kind, promotional = false, metaTemplate = null }) => {
      const broadcast = await asTenant(() => WaBroadcast.create({
        title: `teste ${kind}`, body: 'Oi', status: 'draft', kind, promotional, rate_limit_per_min: 60, total_count: 2
      }));
      await asTenant(() => WaBroadcast.addRecipients(broadcast.id, [
        { phone: FONE.a, contract: '401', clientName: 'ANA', body: 'Oi', metaTemplate },
        { phone: FONE.b, contract: '402', clientName: 'BRUNO', body: 'Oi', metaTemplate }
      ]));
      await asTenant(() => WaBroadcastService.setStatus(broadcast.id, 'running'));
      await asTenant(() => WaBroadcastService.tickForTenant());
      const linhas = await getDb()('wa_broadcast_recipients').where({ broadcast_id: broadcast.id });
      const detalhe = await asTenant(() => WaBroadcastService.recipients(broadcast.id));
      return {
        estado: Object.fromEntries(linhas.map((l) => [l.contract, `${l.status}${l.error_msg ? `:${l.error_msg}` : ''}`])),
        resumo: detalhe.summary.marketingOptOut
      };
    };

    // Texto livre marcado como promocional: a Ana fica de fora.
    assert.deepEqual(await enviar({ kind: 'general', promotional: true }),
      { estado: { 401: 'skipped:marketing_opt_out', 402: 'sent' }, resumo: 1 });
    // Aviso geral NÃO promocional: sai para os dois.
    assert.deepEqual((await enviar({ kind: 'general' })).estado, { 401: 'sent', 402: 'sent' });
    // Cobrança com modelo UTILITY: sai.
    assert.deepEqual((await enviar({
      kind: 'billing', metaTemplate: { name: 'aviso_fatura', language: 'pt_BR', params: ['R$ 99'] }
    })).estado, { 401: 'sent', 402: 'sent' });
    // Qualquer campanha com modelo de MARKETING: pula a Ana.
    assert.deepEqual((await enviar({
      kind: 'billing', metaTemplate: { name: 'promo_do_mes', language: 'pt_BR', params: ['10%'] }
    })).estado, { 401: 'skipped:marketing_opt_out', 402: 'sent' });
  });

  it('a prévia da campanha promocional diz quantos serão pulados', async () => {
    await asTenant(() => WaMarketingOptOut.record({ waPhone: FONE.a, source: 'keyword' }));
    const previa = async (promotional) => (await api('/broadcasts/preview', {
      method: 'POST',
      body: { filters: { contracts: ['401', '402'] }, body: 'Oi {{nome}}', promotional }
    })).body.data;
    const promo = await previa(true);
    assert.equal(promo.marketing, true);
    assert.equal(promo.counts.marketingOptOut, 1);
    // Ela continua na lista: o pulo é registrado no envio, com o motivo.
    assert.equal(promo.counts.reachable, 2);
    const aviso = await previa(false);
    assert.equal(aviso.marketing, false);
    assert.equal(aviso.counts.marketingOptOut, 0);

    const criada = await api('/broadcasts', {
      method: 'POST',
      body: { title: 'Promo', filters: { contracts: ['401', '402'] }, body: 'Oi {{nome}}', promotional: true }
    });
    assert.equal(criada.status, 201, JSON.stringify(criada.body));
    assert.equal(criada.body.data.broadcast.promotional, true);
    assert.equal(criada.body.data.skipped.marketingOptOut, 1);
  });
});

describe('a equipe, na conversa', () => {
  it('marca e desmarca, a conversa mostra o selo e a trilha registra', async () => {
    await getDb()('audit_log').where({ action: 'whatsapp.marketing_opt_out_changed' }).del();
    const conversa = await conversaDe(FONE.b);

    const marcar = await api(`/conversations/${conversa.id}/marketing-opt-out`, { method: 'POST' });
    assert.equal(marcar.status, 200, JSON.stringify(marcar.body));
    assert.equal(marcar.body.data.marketingOptOut.source, 'operator');
    assert.ok(marcar.body.data.marketingOptOut.since);
    const [linha] = await ativos();
    assert.ok(linha.created_by, 'quem marcou fica na linha');

    const lida = await api(`/conversations/${conversa.id}`);
    assert.equal(lida.body.data.marketingOptOut.source, 'operator');
    const lista = await api('/conversations?status=all');
    const naLista = lista.body.data.find((c) => c.id === conversa.id);
    assert.ok(naLista, JSON.stringify(lista.body.data.map((c) => c.id)));
    assert.equal(naLista.marketingOptOut?.source, 'operator');

    const desmarcar = await api(`/conversations/${conversa.id}/marketing-opt-out`, { method: 'DELETE' });
    assert.equal(desmarcar.status, 200);
    assert.equal(desmarcar.body.data.marketingOptOut, null);
    const [revogada] = await getDb()('wa_marketing_opt_outs').where({ wa_phone_e164: FONE.b });
    assert.equal(revogada.revoked_source, 'operator');

    const trilha = await getDb()('audit_log').where({ action: 'whatsapp.marketing_opt_out_changed' }).orderBy('id');
    assert.equal(trilha.length, 2);
    assert.deepEqual(trilha.map((t) => JSON.parse(t.detail).optedOut), [true, false]);
    assert.ok(!JSON.stringify(trilha).includes(FONE.b), 'a trilha não guarda o telefone');

    assert.equal((await api('/conversations/999999/marketing-opt-out', { method: 'POST' })).status, 404);
  });

  it('a lista de contatos mostra quem não quer promoções', async () => {
    await asTenant(() => WaMarketingOptOut.record({ waPhone: FONE.a, source: 'keyword' }));
    const contatos = (await api('/contacts?limit=50')).body.data.contacts;
    const por = new Map(contatos.map((c) => [c.contract, c]));
    assert.equal(por.get('401').marketingOptOut, true);
    assert.equal(por.get('401').optedOut, false, 'não é o não perturbe');
    assert.equal(por.get('402').marketingOptOut, false);
  });
});

describe('a configuração', () => {
  it('guarda palavras normalizadas e recusa a mesma palavra nos dois lados', async () => {
    const salva = await api('/marketing-opt-out', {
      method: 'PUT',
      body: { stopWords: ['Chega!', 'Não quero promoção'], resumeWords: ['Pode mandar'], confirmText: 'Ok, sem promoções.' }
    });
    assert.equal(salva.status, 200, JSON.stringify(salva.body));
    assert.deepEqual(salva.body.data.stopWords, ['chega', 'nao quero promocao']);
    assert.equal(salva.body.data.confirmText, 'Ok, sem promoções.');
    assert.ok(salva.body.data.defaults.stopWords.includes('parar'));

    await hook(recebida(FONE.c, 'chega'));
    assert.equal((await ativos()).length, 1);
    assert.deepEqual((await respostasDoBot(FONE.c)).map((m) => m.body), ['Ok, sem promoções.']);

    const ruim = await api('/marketing-opt-out', { method: 'PUT', body: { stopWords: ['parar'], resumeWords: ['parar'] } });
    assert.equal(ruim.status, 400);
    assert.equal(ruim.body.code, 'marketing_words_overlap');
  });
});
