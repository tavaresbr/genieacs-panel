import crypto from 'node:crypto';
import http from 'node:http';
import { signV4 } from '../../src/services/backup/s3Client.js';

/**
 * Um S3 de mentira, em `127.0.0.1`, no estilo de caminho (`/bucket/chave`) —
 * o do MinIO. Implementa o que o backup externo usa: HeadBucket, PutObject,
 * o multipart (Create/UploadPart/Complete/Abort), ListObjectsV2 com
 * paginação, GetObject, HeadObject e DeleteObject.
 *
 * E CONFERE a assinatura: recalcula o SigV4 a partir do que chegou pela rede
 * (o caminho cru, a query, os cabeçalhos assinados) e do segredo que ele
 * conhece, e responde 403 `SignatureDoesNotMatch` quando não bate — o mesmo
 * que a AWS faria. Também confere o `x-amz-content-sha256` contra o corpo.
 * Uma divergência de codificação entre o que o cliente assina e o que ele
 * manda aparece aqui, e não só em produção.
 */

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function erroXml(res, status, code, message = code) {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${esc(message)}</Message></Error>`);
}

export async function startFakeS3({ bucket, accessKeyId, secretAccessKey, region = 'us-east-1', pageSize = 1000 } = {}) {
  const estado = {
    objects: new Map(),
    uploads: new Map(),
    requests: [],
    /** As recusas de assinatura, para o teste dizer por quê. */
    rejections: [],
    /** `(req) => status|null`: injeta uma falha. */
    fail: null
  };
  let seq = 0;

  const server = http.createServer((req, res) => {
    const partes = [];
    req.on('data', (p) => partes.push(p));
    req.on('end', () => {
      const body = Buffer.concat(partes);
      const [cru, qs = ''] = req.url.split('?');
      const query = qs ? qs.split('&').map((par) => {
        const [k, v = ''] = par.split('=');
        return [decodeURIComponent(k), decodeURIComponent(v)];
      }) : [];
      const q = Object.fromEntries(query);
      estado.requests.push({ method: req.method, path: cru, query: q, bytes: body.length });

      const injetada = estado.fail?.(req, q);
      if (injetada) return erroXml(res, injetada, 'InternalError', 'injected failure');

      // A assinatura.
      const auth = String(req.headers.authorization || '');
      const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
      if (!m || m[1] !== accessKeyId || m[3] !== region) {
        estado.rejections.push({ code: 'InvalidAccessKeyId', auth });
        return erroXml(res, 403, 'InvalidAccessKeyId');
      }
      // Um Map, e não um objeto: os nomes vêm da requisição (`SignedHeaders`).
      const assinados = new Map();
      for (const nome of m[4].split(';')) assinados.set(nome, req.headers[nome]);
      const { signature } = signV4({
        method: req.method, path: cru, query, headers: Object.fromEntries(assinados), payloadHash: req.headers['x-amz-content-sha256'],
        region, accessKeyId, secretAccessKey
      });
      if (signature !== m[5]) {
        estado.rejections.push({ code: 'SignatureDoesNotMatch', method: req.method, path: cru });
        return erroXml(res, 403, 'SignatureDoesNotMatch');
      }
      if (body.length && req.headers['x-amz-content-sha256'] !== sha(body)) {
        return erroXml(res, 400, 'XAmzContentSHA256Mismatch');
      }

      const segmentos = cru.split('/').slice(1);
      if (decodeURIComponent(segmentos[0] || '') !== bucket) return erroXml(res, 404, 'NoSuchBucket');
      const key = segmentos.slice(1).map(decodeURIComponent).join('/');

      if (!key) {
        if (req.method === 'HEAD') return res.writeHead(200).end();
        if (req.method === 'GET' && q['list-type'] === '2') {
          const todos = [...estado.objects.keys()].filter((k) => k.startsWith(q.prefix || '')).sort();
          const inicio = Number(q['continuation-token'] || 0);
          const pagina = todos.slice(inicio, inicio + pageSize);
          const truncado = inicio + pageSize < todos.length;
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>${esc(bucket)}</Name>`
            + `<IsTruncated>${truncado}</IsTruncated>${truncado ? `<NextContinuationToken>${inicio + pageSize}</NextContinuationToken>` : ''}`
            + pagina.map((k) => `<Contents><Key>${esc(k)}</Key><Size>${estado.objects.get(k).body.length}</Size>`
              + `<LastModified>2026-11-03T03:17:00.000Z</LastModified><ETag>"x"</ETag></Contents>`).join('')
            + '</ListBucketResult>');
        }
        return erroXml(res, 400, 'NotImplemented');
      }

      const metadata = Object.fromEntries(Object.entries(req.headers)
        .filter(([k]) => k.startsWith('x-amz-meta-')).map(([k, v]) => [k.slice(11), v]));

      if (req.method === 'POST' && 'uploads' in q) {
        const id = `up-${++seq}`;
        estado.uploads.set(id, { key, metadata, parts: new Map() });
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${esc(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
      }
      if (req.method === 'PUT' && q.uploadId) {
        const up = estado.uploads.get(q.uploadId);
        if (!up) return erroXml(res, 404, 'NoSuchUpload');
        up.parts.set(Number(q.partNumber), body);
        res.writeHead(200, { etag: `"${crypto.createHash('md5').update(body).digest('hex')}"` });
        return res.end();
      }
      if (req.method === 'POST' && q.uploadId) {
        const up = estado.uploads.get(q.uploadId);
        if (!up) return erroXml(res, 404, 'NoSuchUpload');
        const numeros = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((x) => Number(x[1]));
        const junto = Buffer.concat(numeros.map((n) => up.parts.get(n)));
        estado.objects.set(key, { body: junto, metadata: up.metadata, multipart: true, parts: numeros.length });
        estado.uploads.delete(q.uploadId);
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end(`<CompleteMultipartUploadResult><Key>${esc(key)}</Key><ETag>"m-${numeros.length}"</ETag></CompleteMultipartUploadResult>`);
      }
      if (req.method === 'DELETE' && q.uploadId) {
        estado.uploads.delete(q.uploadId);
        return res.writeHead(204).end();
      }
      if (req.method === 'PUT') {
        estado.objects.set(key, { body, metadata });
        res.writeHead(200, { etag: '"x"' });
        return res.end();
      }
      const obj = estado.objects.get(key);
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (!obj) return req.method === 'HEAD' ? res.writeHead(404).end() : erroXml(res, 404, 'NoSuchKey');
        const h = { 'content-length': obj.body.length, etag: '"x"' };
        for (const [k, v] of Object.entries(obj.metadata)) h[`x-amz-meta-${k}`] = v;
        res.writeHead(200, h);
        return res.end(req.method === 'GET' ? obj.body : undefined);
      }
      if (req.method === 'DELETE') {
        estado.objects.delete(key);
        return res.writeHead(204).end();
      }
      return erroXml(res, 400, 'NotImplemented');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return Object.assign(estado, {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  });
}
