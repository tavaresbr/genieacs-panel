import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../config/paths.js';
import { currentTenantId } from '../config/tenantContext.js';
import { safeFetch } from '../utils/wa/ssrfGuard.js';
import MessengerMessage from '../models/MessengerMessage.js';

/**
 * O anexo que a pessoa mandou no Messenger: baixado da Meta e guardado em disco.
 *
 * Por que baixar: o link que vem no evento é de CDN da Meta e expira em pouco
 * tempo — guardar só o link é guardar um anexo que some. Por que cuidar tanto:
 * o link vem de um evento assinado, mas o conteúdo é de um desconhecido, então
 * o mesmo rigor do WhatsApp vale aqui (ver `waMediaService.js`):
 *
 * - só `https` e só hosts da Meta (um evento assinado não é licença para o
 *   servidor buscar qualquer endereço), e ainda pela guarda anti-SSRF
 *   (`safeFetch`: o endereço aprovado é o conectado);
 * - teto de tamanho e de tempo;
 * - o tipo gravado sai de uma lista fechada, nunca do que o servidor disse, e
 *   o nome do arquivo no disco é nosso (nada do que veio no payload vira
 *   caminho);
 * - nada aqui lança: anexo que não desceu é mensagem sem arquivo (o link
 *   original continua como último recurso), e nunca um evento de entrada perdido.
 */

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
/** Subpasta de `DATA_DIR`; o caminho gravado no banco é relativo a `DATA_DIR`. */
export const MEDIA_DIR = 'messenger-media';

const META_HOST = /(^|\.)(fbcdn\.net|fbsbx\.com|facebook\.com|cdninstagram\.com)$/i;

/** O tipo que gravamos → a extensão do arquivo. Fora daqui vira `application/octet-stream`/`.bin`. */
const EXTENSIONS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'application/pdf': 'pdf'
};
const FALLBACK_TYPE = 'application/octet-stream';

/** Se o endereço é de CDN da Meta, em `https`. */
export function isMetaMediaUrl(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'https:' && !url.port && !url.username && !url.password && META_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

/** O tipo de uma lista fechada: o que o servidor disse, ou o tipo de "bytes desconhecidos". */
export function normalizeMime(contentType) {
  const first = String(contentType || '').split(';')[0].trim().toLowerCase();
  return Object.hasOwn(EXTENSIONS, first) ? first : FALLBACK_TYPE;
}

let fetcher = (...args) => safeFetch(...args);

/** Para os testes: a CDN falsa entra aqui (o real passa pela guarda anti-SSRF). */
export function setMediaFetcher(fn) {
  fetcher = fn || ((...args) => safeFetch(...args));
}

const inFlight = new Set();

class MessengerMediaService {
  /**
   * Baixa e guarda o anexo de uma mensagem já gravada. Nunca lança.
   * @returns {Promise<boolean>} se o arquivo ficou guardado
   */
  static async capture(message) {
    if (!message?.id || !message.attachment_url || message.attachment_path) return false;
    if (!isMetaMediaUrl(message.attachment_url)) return false;
    let absolute = null;
    try {
      const response = await fetcher(message.attachment_url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_MEDIA_BYTES });
      if (response.status !== 200) return false;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) return false;
      const mime = normalizeMime(response.headers.get('content-type'));
      const relative = path.join(
        MEDIA_DIR,
        `t${Number(currentTenantId())}`,
        String(Number(message.conversation_id)),
        `${Number(message.id)}-${crypto.randomBytes(6).toString('hex')}.${EXTENSIONS[mime] ?? 'bin'}`
      );
      absolute = path.resolve(DATA_DIR, relative);
      await fsp.mkdir(path.dirname(absolute), { recursive: true });
      await fsp.writeFile(absolute, bytes, { flag: 'wx' });
      await MessengerMessage.update(message.id, {
        attachment_path: relative,
        attachment_mime: mime,
        attachment_size: bytes.length
      });
      return true;
    } catch (error) {
      if (absolute) await fsp.rm(absolute, { force: true }).catch(() => {});
      console.warn(`[messenger] could not store attachment of message ${message.id}: ${String(error?.message ?? error).slice(0, 120)}`);
      return false;
    }
  }

  /**
   * Baixa SEM segurar a entrega: a Meta espera a resposta do webhook, e um
   * arquivo grande não pode atrasá-la. Quem precisa esperar (os testes) usa `idle()`.
   */
  static captureInBackground(message) {
    const job = this.capture(message).finally(() => inFlight.delete(job));
    inFlight.add(job);
    return job;
  }

  /** Espera os downloads em andamento. */
  static async idle() {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
  }

  /** Apaga os arquivos de uma lista de linhas (melhor esforço; some junto com as mensagens). */
  static async removeFiles(rows) {
    const root = path.resolve(DATA_DIR, MEDIA_DIR);
    for (const row of rows) {
      const relative = String(row?.attachment_path ?? '');
      if (!relative) continue;
      const absolute = path.resolve(DATA_DIR, relative);
      // Só dentro da pasta do Messenger: um caminho gravado nunca apaga o que está fora dela.
      if (!absolute.startsWith(root + path.sep)) continue;
      await fsp.rm(absolute, { force: true }).catch(() => {});
    }
  }
}

export default MessengerMediaService;
