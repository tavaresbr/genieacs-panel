import crypto from 'node:crypto';
import { runInTenant } from '../config/tenantContext.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WaMetaEvent from '../models/WaMetaEvent.js';
import WhatsAppConfigService, { WaError } from './whatsappConfigService.js';
import { EvolutionClient } from './evolutionClient.js';
import { bridgeAppSecret, bridgeForwardTimeoutMs } from '../utils/wa/metaBridgeConfig.js';

/**
 * A ponte de eventos da Meta (fase B1: MODO SOMBRA).
 *
 * A Meta chama o painel em vez do Evolution; o painel confere a assinatura
 * (`routes/metaWebhook.js`) e entrega ao Evolution do número, sem tocar no que
 * chegou. Nesta fase a ponte NÃO trata evento nenhum: o que o Evolution recebe é
 * o que ele recebia quando a Meta chamava direto, byte a byte, com a assinatura
 * original — e é por isso que ligá-la não muda nada que o painel grava. O que ela
 * acrescenta é a medida: cada entrega encaminhada deixa uma linha em
 * `wa_meta_events` (quando, que campos, quanto, se o Evolution aceitou), que é o
 * que as fases seguintes (eco do celular, histórico) precisam provar antes de
 * existir. O desenho completo: `docs/whatsapp-coexistencia-ponte-plan.md`.
 *
 * ── Entrega pelo menos uma vez ─────────────────────────────────────────
 * O Evolution não aceitou (ou não respondeu a tempo): a resposta é 500, e a
 * Meta reenvia. É o mesmo contrato de quando ela falava com o Evolution
 * direto, e a duplicata que a reentrega possa causar é absorvida pelo
 * `external_id` único das mensagens. Número que o painel não conhece NÃO é
 * encaminhado (não há Evolution a quem entregar) e responde 200: 4xx/5xx a cada
 * entrega faria a Meta desativar o callback de todos.
 */

/** O Evolution responde `{status:'success'}`; nada além de um recibo cabe aqui. */
const FORWARD_MAX_RESPONSE_BYTES = 64 * 1024;
/** Quantas mudanças de uma entrega entram no roteamento: o resto é cortado (e, na dúvida, perdido). */
const MAX_CHANGES = 500;
const META_ID = /^\d{5,32}$/;
const FIELDS_LIMIT = 200;
/** Os metadados da ponte guardam 14 dias; a poda roda no máximo de hora em hora por provedor. */
const PURGE_DAYS = 14;
const PURGE_EVERY_MS = 60 * 60 * 1000;
const lastPurge = new Map();

/** Zera a trava da poda (só os testes: em produção ela vale uma hora por provedor). */
export function resetPurgeThrottle() {
  lastPurge.clear();
}

/** O HMAC que a Meta usa, para as entregas que o painel REMONTA (o corpo original assina o original). */
export function signBody(bytes) {
  return `sha256=${crypto.createHmac('sha256', bridgeAppSecret()).update(bytes).digest('hex')}`;
}

/**
 * As mudanças de uma entrega, uma a uma: de que entrada e posição vieram, o
 * `field` e o `phone_number_id` (que diz de quem é). Corpo que não é de uma conta
 * do WhatsApp Business devolve lista vazia.
 */
export function listChanges(body) {
  if (!body || typeof body !== 'object' || body.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) {
    return [];
  }
  const units = [];
  body.entry.forEach((entry, e) => {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    changes.forEach((change, c) => {
      if (units.length >= MAX_CHANGES) return;
      units.push({
        e,
        c,
        entryId: String(entry?.id ?? ''),
        field: String(change?.field ?? '').slice(0, 64),
        phoneNumberId: String(change?.value?.metadata?.phone_number_id ?? '')
      });
    });
  });
  return units;
}

/** O corpo só com as mudanças `units`, na ordem de origem, mantendo `object` e o resto de cada entrada. */
export function subsetBody(body, units) {
  const byEntry = new Map();
  for (const unit of units) {
    if (!byEntry.has(unit.e)) byEntry.set(unit.e, []);
    byEntry.get(unit.e).push(unit.c);
  }
  return {
    ...body,
    entry: [...byEntry.entries()].map(([e, indexes]) => ({
      ...body.entry[e],
      changes: indexes.map((c) => body.entry[e].changes[c])
    }))
  };
}

/** De quem é esta mudança: pelo número, e na falta dele (`account_update`) pela WABA. */
async function resolveAccount(unit) {
  if (META_ID.test(unit.phoneNumberId)) {
    const byPhone = await WhatsAppAccount.getByMetaPhoneNumberId(unit.phoneNumberId);
    if (byPhone) return byPhone;
  }
  if (META_ID.test(unit.entryId)) return WhatsAppAccount.getByMetaWabaId(unit.entryId);
  return null;
}

function failureCode(error) {
  if (error instanceof WaError) return String(error.code || 'forward_failed').slice(0, 64);
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  return 'unreachable';
}

/**
 * Entrega os bytes ao `/webhook/meta` do Evolution da conta.
 *
 * Pelo mesmo cliente de todo o resto (`EvolutionClient`): TLS obrigatório, a
 * allowlist do provedor, o endereço resolvido e fixado antes de conectar e nenhum
 * redirecionamento seguido. Sem credencial: o Evolution não pede (e mandar a
 * chave da instância a um endereço que não é o dela nunca é o que se quer).
 */
async function forward(account, bytes, signature) {
  const started = Date.now();
  try {
    const config = await runInTenant(account.tenant_id, () => WhatsAppConfigService.getConfig());
    const client = new EvolutionClient({ baseUrl: account.base_url, allowedHosts: config.allowedHosts });
    client.assertPolicy();
    const response = await client.open('/webhook/meta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
      body: bytes,
      maxBytes: FORWARD_MAX_RESPONSE_BYTES,
      timeoutMs: bridgeForwardTimeoutMs()
    });
    const ok = response.status >= 200 && response.status < 300;
    return { ok, http: response.status, ms: Date.now() - started, error: ok ? null : `http_${response.status}` };
  } catch (error) {
    return { ok: false, http: null, ms: Date.now() - started, error: failureCode(error) };
  }
}

/** Grava a linha da entrega. Nunca lança: é medida pendurada num caminho que não pode falhar por causa dela. */
async function record(account, units, bytes, result) {
  try {
    const fields = [...new Set(units.map((unit) => unit.field).filter(Boolean))].join(',').slice(0, FIELDS_LIMIT);
    await runInTenant(account.tenant_id, async () => {
      await WaMetaEvent.record({
        account_id: account.id,
        fields,
        changes: units.length,
        bytes,
        forward_status: result.ok ? 'ok' : 'failed',
        forward_http: result.http,
        forward_ms: Math.min(result.ms, 2_147_483_000),
        forward_error: result.error,
        received_at: new Date()
      });
      const last = lastPurge.get(account.tenant_id) ?? 0;
      if (Date.now() - last > PURGE_EVERY_MS) {
        lastPurge.set(account.tenant_id, Date.now());
        await WaMetaEvent.purgeOlderThan(PURGE_DAYS);
      }
    });
  } catch (error) {
    console.error('[meta-bridge] could not record delivery:', error?.message || error);
  }
}

class MetaBridgeService {
  /**
   * Uma entrega JÁ AUTENTICADA (a rota conferiu a assinatura), do corpo bruto ao
   * resultado. Devolve o status HTTP que a Meta deve receber.
   *
   * @param {Buffer} rawBody o corpo como chegou
   * @param {string} signature o `X-Hub-Signature-256` que a Meta mandou para ESTE corpo
   * @returns {Promise<{ status: 200|500, skipped?: string, forwarded?: number, failed?: number, unknown?: number }>}
   */
  static async handleDelivery(rawBody, signature) {
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      // Assinado e ilegível: reentregar não conserta, então 200 e segue.
      return { status: 200, skipped: 'invalid_json' };
    }
    const units = listChanges(body);
    if (!units.length) return { status: 200, skipped: 'no_changes' };

    // Cada mudança vai para o Evolution do número a que pertence. Resolve uma vez por (número, WABA).
    const cache = new Map();
    const groups = new Map();
    let unknown = 0;
    for (const unit of units) {
      const key = `${unit.phoneNumberId}|${unit.entryId}`;
      if (!cache.has(key)) cache.set(key, await resolveAccount(unit)); // eslint-disable-line no-await-in-loop
      const account = cache.get(key);
      if (!account) {
        unknown += 1;
        continue;
      }
      const target = `${account.tenant_id}|${account.base_url}`;
      if (!groups.has(target)) groups.set(target, { account, units: [] });
      groups.get(target).units.push(unit);
    }
    if (!groups.size) return { status: 200, skipped: 'unknown_account', unknown };

    // O caso comum — um destino, e ele leva TUDO — entrega o corpo original,
    // byte a byte e com a assinatura original. Só uma entrega que se parte entre
    // destinos é remontada, e então assinada de novo com o segredo do app.
    const whole = groups.size === 1 && unknown === 0 && [...groups.values()][0].units.length === units.length;
    const jobs = [...groups.values()].map(async ({ account, units: mine }) => {
      let bytes = rawBody;
      let sig = signature;
      if (!whole) {
        bytes = Buffer.from(JSON.stringify(subsetBody(body, mine)), 'utf8');
        sig = signBody(bytes);
      }
      const result = await forward(account, bytes, sig);
      // `byteLength` e não `.length`: devolve sempre um número, qualquer que seja o tipo do corpo.
      await record(account, mine, Buffer.byteLength(bytes), result);
      return result;
    });
    const results = await Promise.all(jobs);
    const failed = results.filter((result) => !result.ok).length;
    return {
      status: failed ? 500 : 200,
      forwarded: results.length - failed,
      failed,
      ...(unknown ? { unknown } : {})
    };
  }
}

export default MetaBridgeService;
