import { EXPORT_FORMAT_VERSION, exportTenant } from '../services/tenantExportService.js';

/**
 * Hands the export to the caller a line at a time.
 *
 * Newline-delimited JSON, and the choice is about failure rather than taste.
 * One JSON document would have to be either built in memory — the thing the
 * service exists not to do — or assembled bracket by bracket into the socket,
 * and a stream cut halfway through that is not valid JSON at all: no parser
 * gets a single row out of it. NDJSON truncated at any point is still every
 * complete line up to the cut, and the missing `end` record says the cut
 * happened. Every line also stands alone, which is what lets a consumer stream
 * a hundred thousand rows without a streaming parser.
 */
const CONTENT_TYPE = 'application/x-ndjson; charset=utf-8';

/** Slugs are already `[a-z0-9-]`, but a filename in a header is not the place to trust that. */
function safeName(slug) {
  const cleaned = String(slug || 'tenant').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return cleaned.replace(/^-+|-+$/g, '') || 'tenant';
}

/**
 * Resolves when the socket wants more, rejects when the caller has gone.
 *
 * Without the `close` arm this waits on a `drain` that a disconnected client
 * will never send, and the export keeps its database walk and its connection
 * open for as long as the process lives.
 */
function whenWritable(res) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain);
      res.off('close', onClose);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('client closed the export')); };
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

const ExportController = {
  async download(req, res, next) {
    const stream = exportTenant();
    let started = false;

    try {
      for await (const record of stream) {
        if (!started) {
          // The first record is the manifest, and it is where the provider's
          // slug comes from — one fewer query than asking for it again here.
          started = true;
          res.status(200);
          res.setHeader('Content-Type', CONTENT_TYPE);
          res.setHeader('X-Export-Format-Version', String(EXPORT_FORMAT_VERSION));
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="skygenpanel-export-${safeName(record.tenant?.slug)}`
            + `-${new Date().toISOString().slice(0, 10)}.ndjson"`
          );
        }

        // Back-pressure, and it is load-bearing: a slow or distant client that
        // is never waited for makes Node buffer the whole export in memory,
        // which is precisely the failure the paging avoids one layer down.
        if (!res.write(`${JSON.stringify(record)}\n`)) await whenWritable(res);
      }
      res.end();
    } catch (error) {
      // Nothing has been sent yet, so the ordinary error path can still choose
      // a status and phrase the message.
      if (!started) return next(error);

      // Past the first byte the status is spent. The consumer's check is the
      // absence of the `end` record; this line only says why, and is written
      // best-effort because the socket may be what failed.
      console.error('Tenant export failed mid-stream:', error);
      if (!res.writableEnded) {
        res.write(`${JSON.stringify({ type: 'error', message: 'export interrupted' })}\n`);
        res.end();
      }
    }
    return undefined;
  }
};

export default ExportController;
