import crypto from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyWebhookSignature } from '../src/utils/webhookSignature.js';

/**
 * A verificação do webhook do SGP, sem servidor.
 *
 * O caso que motivou este arquivo: com `requireTimestamp` ligado, uma
 * assinatura só sobre o corpo ainda passava. Ela não cobre o carimbo, então uma
 * entrega capturada podia ser reenviada a qualquer hora com um carimbo novo no
 * cabeçalho — a exigência não protegia de repetição nenhuma.
 */
const SECRET = 'segredo-do-webhook';
const body = Buffer.from(JSON.stringify({ id: 'evt-1', evento: 'liberado', contrato: '4321' }));
const hmac = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
const agora = () => String(Math.trunc(Date.now() / 1000));
const verificar = (headers, requireTimestamp) => verifyWebhookSignature({
  rawBody: body, secret: SECRET, headers, requireTimestamp, toleranceSeconds: 300
});

describe('verifyWebhookSignature', () => {
  describe('sem exigir carimbo (o modo de antes, inalterado)', () => {
    it('aceita a assinatura só do corpo', () => {
      assert.deepEqual(verificar({ 'x-sgp-signature': hmac(body) }, false), { ok: true, reason: null });
    });

    it('aceita também `<timestamp>.<corpo>` quando há carimbo', () => {
      const ts = agora();
      const verdict = verificar({ 'x-sgp-signature': `sha256=${hmac(`${ts}.${body}`)}`, 'x-sgp-timestamp': ts }, false);
      assert.equal(verdict.ok, true);
    });

    it('aceita a assinatura só do corpo mesmo com um carimbo no cabeçalho', () => {
      const verdict = verificar({ 'x-sgp-signature': hmac(body), 'x-sgp-timestamp': agora() }, false);
      assert.equal(verdict.ok, true);
    });

    it('recusa segredo errado', () => {
      const errada = crypto.createHmac('sha256', 'outro').update(body).digest('hex');
      assert.equal(verificar({ 'x-sgp-signature': errada }, false).reason, 'invalid_signature');
    });
  });

  describe('exigindo carimbo', () => {
    it('aceita `<timestamp>.<corpo>` dentro da tolerância, em hex ou base64', () => {
      const ts = agora();
      assert.equal(verificar({ 'x-sgp-signature': hmac(`${ts}.${body}`), 'x-sgp-timestamp': ts }, true).ok, true);
      const b64 = crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('base64');
      assert.equal(verificar({ 'x-signature': b64, 'x-timestamp': ts }, true).ok, true);
    });

    it('recusa a assinatura só do corpo, mesmo com carimbo novo — a repetição', () => {
      const verdict = verificar({ 'x-sgp-signature': hmac(body), 'x-sgp-timestamp': agora() }, true);
      assert.deepEqual(verdict, { ok: false, reason: 'invalid_signature' });
    });

    it('recusa a assinatura de um carimbo antigo reaproveitada com um carimbo novo', () => {
      const velho = String(Number(agora()) - 4000);
      const verdict = verificar({ 'x-sgp-signature': hmac(`${velho}.${body}`), 'x-sgp-timestamp': agora() }, true);
      assert.equal(verdict.reason, 'invalid_signature');
    });

    it('recusa carimbo fora da tolerância e carimbo ausente', () => {
      const velho = String(Number(agora()) - 4000);
      assert.equal(verificar({ 'x-sgp-signature': hmac(`${velho}.${body}`), 'x-sgp-timestamp': velho }, true).reason, 'stale_timestamp');
      assert.equal(verificar({ 'x-sgp-signature': hmac(body) }, true).reason, 'missing_timestamp');
    });

    it('assina o carimbo como veio no cabeçalho, também em ISO', () => {
      const iso = new Date().toISOString();
      assert.equal(verificar({ 'x-sgp-signature': hmac(`${iso}.${body}`), 'x-sgp-timestamp': iso }, true).ok, true);
    });
  });
});
