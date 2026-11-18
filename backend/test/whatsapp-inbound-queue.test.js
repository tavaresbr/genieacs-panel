import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, call, getDb, insertReturningId, runInTenant, startTestServers, stopTestServers, waInboundIdle } from './helpers/harness.js';

const { default: WhatsAppConfigService } = await import('../src/services/whatsappConfigService.js');
const { default: WhatsAppAccount } = await import('../src/models/WhatsAppAccount.js');
const { default: WaBotService } = await import('../src/services/waBotService.js');
const { currentTenantId } = await import('../src/config/tenantContext.js');
const WaInboundQueue = await import('../src/services/waInboundQueue.js');

/**
 * O webhook responde antes do bot.
 *
 * Antes, o handler esperava o bot inteiro — SGP, IA, envio — e uma volta lenta
 * estourava o prazo do Evolution, que reentregava o evento. Agora a resposta
 * sai assim que a mensagem está gravada (o insert com índice único é a
 * deduplicação), e o resto roda na fila por conversa de `waInboundQueue.js`.
 *
 * Os testes daqui usam `fetch` cru onde o ponto é ver a resposta ANTES do bot:
 * o `call` do harness espera a fila esvaziar para toda entrega do webhook.
 */

const ALFA_INSTANCE = 'painel-fila-alfa';
const ALFA_TOKEN = 'segredo-fila-alfa';
const BETA_INSTANCE = 'painel-fila-beta';
const BETA_TOKEN = 'segredo-fila-beta';

let panelUrl;
let alfa;
let beta;
const responderOriginal = WaBotService.responder;

function evento(instance, id, texto, remoteJid = '5593911112222@s.whatsapp.net') {
  return {
    event: 'messages.upsert',
    instance,
    data: {
      key: { remoteJid, fromMe: false, id },
      pushName: 'Cliente da Fila',
      message: { conversation: texto },
      messageType: 'conversation',
      messageTimestamp: 1739990000
    }
  };
}

/** A entrega crua, sem esperar a fila — o que o Evolution vê. */
async function entregaCrua(token, body) {
  const response = await fetch(`${panelUrl}/api/whatsapp-webhook?t=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

function adiado() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

before(async () => {
  ({ panelUrl } = await startTestServers());
  alfa = (await getDb()('tenants').orderBy('id', 'asc').first()).id;
  beta = await insertReturningId('tenants', { slug: 'beta-fila', name: 'Provedor Beta Fila', status: 'active' });

  await asTenant(() => WhatsAppAccount.create({
    name: ALFA_INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.alfa.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-alfa-fila'),
    ...WhatsAppConfigService.encryptWebhookToken(ALFA_TOKEN)
  }));
  await runInTenant(beta, () => WhatsAppAccount.create({
    name: BETA_INSTANCE,
    purpose: 'support',
    flavor: 'v2',
    base_url: 'https://evo.beta.com.br',
    status: 'connected',
    is_default: true,
    ...WhatsAppConfigService.encryptInstanceToken('token-beta-fila'),
    ...WhatsAppConfigService.encryptWebhookToken(BETA_TOKEN)
  }));
});

afterEach(async () => {
  await waInboundIdle();
  WaBotService.responder = responderOriginal;
});

after(async () => {
  await stopTestServers();
});

describe('the WhatsApp webhook answers before the bot', () => {
  it('acks with 200 while a slow bot turn is still running, with the message already stored', async () => {
    const liberar = adiado();
    const chamadas = [];
    WaBotService.responder = async (p) => {
      chamadas.push(p.messageId);
      await liberar.promise;
      return { replied: false, reason: 'test' };
    };

    const { status, body } = await entregaCrua(ALFA_TOKEN, evento(ALFA_INSTANCE, 'FILA-ACK-1', 'oi'));
    assert.equal(status, 200);
    assert.equal(body.success, true);
    assert.equal(body.handled, true);
    assert.ok(body.conversationId, 'the response still names the conversation');

    // Respondido, e o bot ainda não acabou.
    assert.ok(WaInboundQueue.pendingCount() >= 1, 'the bot turn is still pending after the ack');
    const linha = await getDb()('wa_messages').where({ external_id: 'FILA-ACK-1' }).first();
    assert.ok(linha, 'the message is durably stored before the ack');
    const conversa = await getDb()('wa_conversations').where({ id: linha.conversation_id }).first();
    assert.equal(Number(conversa.unread_count) >= 1, true, 'the inbox is bumped before the ack');

    liberar.resolve();
    await waInboundIdle();
    assert.deepEqual(chamadas, [linha.id], 'the bot ran once, for the stored row');
  });

  it('runs the bot once for a redelivered message', async () => {
    let chamadas = 0;
    WaBotService.responder = async () => { chamadas += 1; return { replied: false }; };

    const primeira = await call(`${panelUrl}/api/whatsapp-webhook?t=${ALFA_TOKEN}`, {
      method: 'POST', body: evento(ALFA_INSTANCE, 'FILA-DUP-1', 'segunda via')
    });
    const segunda = await call(`${panelUrl}/api/whatsapp-webhook?t=${ALFA_TOKEN}`, {
      method: 'POST', body: evento(ALFA_INSTANCE, 'FILA-DUP-1', 'segunda via')
    });
    assert.equal(primeira.status, 200);
    assert.equal(segunda.status, 200);
    assert.equal(segunda.body.duplicate, true);

    // E duas entregas simultâneas: uma ganha o insert, a outra é duplicata.
    const [a, b] = await Promise.all([
      entregaCrua(ALFA_TOKEN, evento(ALFA_INSTANCE, 'FILA-DUP-2', 'boleto')),
      entregaCrua(ALFA_TOKEN, evento(ALFA_INSTANCE, 'FILA-DUP-2', 'boleto'))
    ]);
    await waInboundIdle();
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal([a.body, b.body].filter((r) => r.duplicate).length, 1);
    assert.equal(chamadas, 2, 'one bot turn per distinct message, never per delivery');
  });

  it('processes messages of the same conversation in arrival order, one at a time', async () => {
    const log = [];
    const primeiraLenta = adiado();
    WaBotService.responder = async ({ body }) => {
      log.push(`start:${body}`);
      if (body === 'primeira') await primeiraLenta.promise;
      log.push(`end:${body}`);
      return { replied: false };
    };
    const jid = '5593933334444@s.whatsapp.net';
    const r1 = await entregaCrua(ALFA_TOKEN, evento(ALFA_INSTANCE, 'FILA-ORD-1', 'primeira', jid));
    const r2 = await entregaCrua(ALFA_TOKEN, evento(ALFA_INSTANCE, 'FILA-ORD-2', 'segunda', jid));
    const r3 = await entregaCrua(ALFA_TOKEN, evento(ALFA_INSTANCE, 'FILA-ORD-3', 'terceira', jid));
    assert.deepEqual([r1.status, r2.status, r3.status], [200, 200, 200], 'all three acked while the first is stuck');
    assert.equal(r1.body.conversationId, r2.body.conversationId);

    // Outra conversa não espera a primeira.
    const outra = await entregaCrua(ALFA_TOKEN, evento(ALFA_INSTANCE, 'FILA-ORD-X', 'outra', '5593955556666@s.whatsapp.net'));
    assert.equal(outra.status, 200);
    for (let i = 0; i < 50 && !log.includes('end:outra'); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setImmediate(r));
    }
    assert.ok(log.includes('end:outra'), 'a different conversation is not blocked by a slow one');
    assert.ok(!log.includes('start:segunda'), 'the second message waits for the first');

    primeiraLenta.resolve();
    await waInboundIdle();
    const daConversa = log.filter((l) => !l.endsWith(':outra'));
    assert.deepEqual(daConversa, [
      'start:primeira', 'end:primeira',
      'start:segunda', 'end:segunda',
      'start:terceira', 'end:terceira'
    ]);
  });

  it('runs the background turn as the provider whose instance received the event', async () => {
    const vistos = [];
    WaBotService.responder = async ({ conversation }) => {
      vistos.push({ escopo: currentTenantId(), conversa: Number(conversation.tenant_id) });
      return { replied: false };
    };
    await call(`${panelUrl}/api/whatsapp-webhook?t=${BETA_TOKEN}`, {
      method: 'POST', body: evento(BETA_INSTANCE, 'FILA-TEN-B', 'oi do beta')
    });
    await call(`${panelUrl}/api/whatsapp-webhook?t=${ALFA_TOKEN}`, {
      method: 'POST', body: evento(ALFA_INSTANCE, 'FILA-TEN-A', 'oi do alfa')
    });
    assert.deepEqual(vistos, [
      { escopo: Number(beta), conversa: Number(beta) },
      { escopo: Number(alfa), conversa: Number(alfa) }
    ]);
  });

  it('refuses to enqueue for a provider other than the one in scope', async () => {
    assert.throws(
      () => runInTenant(alfa, () => WaInboundQueue.enqueue(beta, 'x', async () => {})),
      /does not match/
    );
    assert.throws(() => WaInboundQueue.enqueue(0, 'x', async () => {}), /provider id/);
  });

  it('swallows a background failure, logs a fixed line, and keeps serving', async () => {
    const rejeicoes = [];
    const onRejeicao = (motivo) => rejeicoes.push(motivo);
    process.on('unhandledRejection', onRejeicao);
    const erros = [];
    const consoleError = console.error;
    console.error = (...args) => { erros.push(args); };
    try {
      WaBotService.responder = async () => {
        throw new Error('boom com dado do pedido\nlinha forjada');
      };
      const { status } = await entregaCrua(ALFA_TOKEN, evento(ALFA_INSTANCE, 'FILA-ERR-1', 'oi'));
      assert.equal(status, 200, 'the ack does not depend on the bot');
      await waInboundIdle();
      await new Promise((r) => setImmediate(r));
    } finally {
      console.error = consoleError;
      process.off('unhandledRejection', onRejeicao);
    }
    assert.deepEqual(erros, [['WhatsApp webhook background processing failed']]);
    assert.equal(rejeicoes.length, 0, 'no unhandled rejection');

    // A conversa não ficou travada: a próxima mensagem dela ainda roda.
    let rodou = false;
    WaBotService.responder = async () => { rodou = true; return { replied: false }; };
    const { status } = await call(`${panelUrl}/api/whatsapp-webhook?t=${ALFA_TOKEN}`, {
      method: 'POST', body: evento(ALFA_INSTANCE, 'FILA-ERR-2', 'de novo')
    });
    assert.equal(status, 200);
    assert.equal(rodou, true);
  });

  it('drain resolves true when idle and false when the deadline passes first', async () => {
    assert.equal(await WaInboundQueue.drain(50), true);
    const preso = adiado();
    await runInTenant(alfa, async () => { WaInboundQueue.enqueue(alfa, 'drain', () => preso.promise); });
    assert.equal(await WaInboundQueue.drain(20), false);
    preso.resolve();
    assert.equal(await WaInboundQueue.drain(1000), true);
  });

  it('releases the conversation queue when a task stalls past the deadline', async () => {
    const preso = adiado();
    const ordem = [];
    const avisos = [];
    const warn = console.warn;
    console.warn = (...a) => { avisos.push(a.join(' ')); };
    try {
      await runInTenant(alfa, async () => {
        WaInboundQueue.enqueue(alfa, 'stall', async () => { ordem.push('preso'); await preso.promise; }, { stallMs: 30 });
        WaInboundQueue.enqueue(alfa, 'stall', async () => { ordem.push('seguinte'); });
      });
      assert.equal(await WaInboundQueue.drain(2000), true);
      assert.deepEqual(ordem, ['preso', 'seguinte']);
      assert.deepEqual(avisos, ['WhatsApp webhook background task stalled; releasing the conversation queue']);
    } finally {
      console.warn = warn;
      preso.resolve();
    }
  });
});
