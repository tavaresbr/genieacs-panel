import { META_WEBHOOK_PATH } from '../../config/metaWebhookPath.js';

/**
 * A configuração da ponte de eventos da Meta, lida do ambiente na hora.
 *
 * Num módulo à parte porque duas pontas a precisam e uma importar a outra
 * seria um ciclo: a rota/serviço da ponte (que RECEBE) e o registro do callback
 * na Meta (`metaWebhookService.js`, que diz à Meta para onde chamar).
 *
 * A ponte é do app da PLATAFORMA — é o segredo dele (`META_APP_SECRET`) que
 * confere a assinatura de cada entrega — e fica desligada até alguém ligar
 * `META_WA_BRIDGE=1`. Sem os quatro requisitos ela responde como se não
 * existisse (404): uma rota pública que aceita o que não consegue conferir é
 * pior que nenhuma.
 */

/** O segredo do app da Meta; confere `X-Hub-Signature-256`. */
export function bridgeAppSecret() {
  return String(process.env.META_APP_SECRET ?? '').trim();
}

/** O token que a Meta confere ao cadastrar o callback (`GET hub.verify_token`). Não é o do Evolution. */
export function bridgeVerifyToken() {
  return String(process.env.META_WA_VERIFY_TOKEN ?? '').trim();
}

/**
 * Para onde a Meta chama: `META_WA_BRIDGE_URL` (https, completa) ou a origem de
 * `PUBLIC_BASE_URL` mais o caminho da ponte. Vazio quando não há endereço https —
 * a Meta não aceita callback sem TLS, e registrar um endereço assim só adiaria o erro.
 */
export function bridgeCallbackUrl() {
  const explicit = String(process.env.META_WA_BRIDGE_URL ?? '').trim();
  const base = String(process.env.PUBLIC_BASE_URL ?? '').trim();
  try {
    if (explicit) {
      const url = new URL(explicit);
      return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
        ? url.toString()
        : '';
    }
    if (!base) return '';
    const url = new URL(base);
    return url.protocol === 'https:' ? `${url.origin}${META_WEBHOOK_PATH}` : '';
  } catch {
    return '';
  }
}

/** A ponte só existe com tudo no lugar. */
export function bridgeConfigured() {
  return process.env.META_WA_BRIDGE === '1'
    && Boolean(bridgeAppSecret())
    && Boolean(bridgeVerifyToken())
    && Boolean(bridgeCallbackUrl());
}

/** O teto do corpo bruto desta rota (`2mb` por padrão). O histórico da coexistência vem em pedaços grandes. */
export function bridgeBodyLimit() {
  const raw = String(process.env.META_WA_BRIDGE_BODY_LIMIT ?? '').trim();
  return /^\d{1,3}(kb|mb)$/i.test(raw) ? raw : '2mb';
}

/**
 * Quanto a ponte espera o Evolution antes de devolver 500 à Meta (5 s por padrão;
 * `META_WA_BRIDGE_FORWARD_TIMEOUT_MS`, entre 100 ms e 15 s). Curto de propósito: a
 * Meta tem prazo próprio e reenvia o que não confirmamos.
 */
export function bridgeForwardTimeoutMs() {
  const raw = Number.parseInt(String(process.env.META_WA_BRIDGE_FORWARD_TIMEOUT_MS ?? ''), 10);
  return Number.isInteger(raw) && raw >= 100 && raw <= 15_000 ? raw : 5_000;
}
