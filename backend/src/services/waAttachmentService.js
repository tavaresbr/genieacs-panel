import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { DATA_DIR } from '../config/paths.js';
import { WaError } from './whatsappConfigService.js';
import { MEDIA_DIR, nomeSeguro } from './waMediaService.js';

/**
 * The file the OPERATOR sends, on its way in.
 *
 * The inbound half of this lives in `waMediaService`: bytes that arrive from
 * the Evolution server, written under `DATA_DIR/wa-media/<conversa>/`. This is
 * the other direction — a photo of the fibre path, the invoice as a PDF — and
 * it shares that module's two decisions on purpose: the path stored in the
 * database is relative to `DATA_DIR`, and the name that came from outside is
 * treated as text to display and never as a path to resolve.
 *
 * What it does NOT share is the type list. `waMediaService` maps whatever the
 * customer's phone sent so the operator can at least see it; this side is an
 * allowlist, because these bytes are written by a request and served back by
 * the panel on the panel's own origin. `image/svg+xml` is left out of it
 * deliberately: an SVG is a script that happens to draw, and the one place it
 * would run is the session of the operator who opened it.
 */

/** The ceiling, in bytes and in the unit the refusal says out loud. */
export const MAX_ATTACHMENT_MB = 16;
export const MAX_ATTACHMENT_BYTES = MAX_ATTACHMENT_MB * 1024 * 1024;

/**
 * The whole allowlist, and the extension each accepted type is stored with.
 *
 * The extension comes from HERE and never from the name the operator sent: the
 * name is a label under a bubble, while the extension is half of what a browser
 * decides to do with the file later. A `laudo.html` uploaded as `image/png` is
 * stored as `.png`, and a `foto.png` uploaded as `text/html` is not stored.
 */
export const ALLOWED_TYPES = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'video/mp4': '.mp4',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3'
});

/** Subfolder of `MEDIA_DIR`, so inbound and outbound never collide. */
export const OUT_DIR = path.posix.join(MEDIA_DIR, 'out');

/** The path the raw-body parser is mounted on. Exported so `app.js` and the
 * router cannot drift apart: reserving the wrong path would hand a 12 MB photo
 * to the global JSON parser. */
export const ATTACHMENT_PATH = '/api/whatsapp/attachments';

/** The `Content-Type` without its parameters, lowercased. */
export function normalizeType(contentType) {
  return String(contentType || '').split(';')[0].trim().toLowerCase();
}

/**
 * The name to show, from the percent-encoded header.
 *
 * `decodeURIComponent` throws on a malformed sequence — a header written by
 * hand rather than by `encodeURIComponent` — and that is a bad name, not a
 * 500: it falls back to the raw header, which `nomeSeguro` then strips of
 * everything that is not a plain filename. Path separators, `..` and leading
 * dots do not survive it, so `../../etc/passwd` arrives here as `passwd` and
 * is stored as a label beside a file whose real name is a UUID.
 */
export function displayName(headerValue, type) {
  const raw = String(headerValue || '');
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    decoded = raw;
  }
  return nomeSeguro(decoded, 'document', type);
}

class WaAttachmentService {
  /**
   * Validates the upload and writes it under `DATA_DIR`.
   *
   * Throws `WaError` with the machine codes the contract froze — the screen
   * translates the code, never the message beside it.
   *
   * @returns {Promise<{ path: string, type: string, name: string }>}
   *   `path` is relative to `DATA_DIR`, which is exactly what `sendMessage`
   *   takes as `attachment.url` and what the inbound side already stores.
   */
  static async store({ buffer, contentType, fileName }) {
    if (!Buffer.isBuffer(buffer)) {
      // No body, or a body the raw parser did not take because the request
      // carried no `Content-Type` at all. Either way there is no accepted type
      // here, which is the same refusal as a rejected one.
      throw new WaError('whatsapp.error.attachmentTypeNotAllowed', {
        code: 'attachment_type_not_allowed',
        status: 415
      });
    }

    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new WaError('whatsapp.error.attachmentTooLarge', {
        code: 'attachment_too_large',
        status: 413,
        vars: { max: MAX_ATTACHMENT_MB }
      });
    }

    if (buffer.length === 0) {
      // Storing it would put a nought-byte file on the customer's phone: a
      // download that opens onto nothing, indistinguishable from a corrupt
      // upload. Refusing costs the operator one retry and says why.
      throw new WaError('whatsapp.error.attachmentEmpty', {
        code: 'attachment_empty',
        status: 400
      });
    }

    const type = normalizeType(contentType);
    const extension = ALLOWED_TYPES[type];
    if (!extension) {
      throw new WaError('whatsapp.error.attachmentTypeNotAllowed', {
        code: 'attachment_type_not_allowed',
        status: 415
      });
    }

    const now = new Date();
    const year = String(now.getUTCFullYear());
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    // A UUID rather than anything derived from the upload: the only two inputs
    // this route has are bytes and a name, and neither may decide where the
    // bytes land. Two operators uploading `foto.jpg` in the same minute is the
    // ordinary case, not the exotic one.
    const relative = path.posix.join(OUT_DIR, year, month, `${crypto.randomUUID()}${extension}`);
    const destination = path.join(DATA_DIR, relative);

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, buffer);

    return {
      path: relative,
      type,
      name: displayName(fileName, type)
    };
  }
}

/**
 * The raw-body mount, kept here so `app.js` carries one line.
 *
 * The reasoning is the SGP webhook's, one step further. The webhook mounts
 * `express.raw` on its path before the global `express.json` because
 * body-parser marks the body as read and the parser below then skips it; here
 * the same reservation is what stops a 12 MB photo from dying as a JSON parse
 * error against a 1 MB ceiling. The panel gets no multipart dependency for one
 * screen, which is the choice the contract froze.
 *
 * The limit is the contract's ceiling exactly, so a file over it is refused
 * before its bytes are buffered — but body-parser's own refusal is a bare 413
 * with no machine code, and a screen that translates codes cannot translate
 * that. The error handler below restates it as the refusal the contract names.
 */
export const attachmentRawBody = [
  express.raw({ type: '*/*', limit: `${MAX_ATTACHMENT_MB}mb` }),
  // Four arguments on purpose: Express only treats an arity-4 function as an
  // error handler. `next` is unused and required.
  // eslint-disable-next-line no-unused-vars
  (err, req, res, next) => {
    if (err?.type !== 'entity.too.large') return next(err);
    return res.status(413).json({
      success: false,
      message: req.t('whatsapp.error.attachmentTooLarge', { max: MAX_ATTACHMENT_MB }),
      code: 'attachment_too_large'
    });
  }
];

export default WaAttachmentService;
