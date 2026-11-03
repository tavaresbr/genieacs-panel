import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

/**
 * Um cliente S3 escrito à mão, sobre `fetch` — sem o aws-sdk.
 *
 * O SDK oficial traz dezenas de pacotes para cinco chamadas: `HeadBucket`,
 * `PutObject` (com o multipart para o arquivo grande), `ListObjectsV2`,
 * `GetObject`/`HeadObject` e `DeleteObject`. O que de fato precisa ser certo
 * é a assinatura (SigV4), e ela tem vetores oficiais — provados em
 * `test/backup-s3.test.js`.
 *
 * Funciona com AWS, Backblaze B2, Wasabi, Cloudflare R2 e MinIO: todos falam o
 * mesmo dialeto do S3 nessas cinco chamadas. Duas diferenças, e as duas são
 * opção: o endereço (`endpoint`) e o estilo do caminho — o MinIO e boa parte
 * dos self-hosted querem `https://host/bucket/chave` (`forcePathStyle`), a AWS
 * prefere o bucket como subdomínio do endpoint (`<bucket>.<endpoint>/chave`).
 *
 * O corpo de cada requisição vai assinado pelo sha256 do conteúdo (e não
 * `UNSIGNED-PAYLOAD`): o servidor confere o hash, e um byte trocado no caminho
 * vira um 400 em vez de um backup corrompido guardado como bom.
 */

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
export const PART_SIZE = 16 * 1024 * 1024;

export class S3Error extends Error {
  constructor(message, { status = null, code = 's3_error' } = {}) {
    super(message);
    this.name = 'S3Error';
    this.status = status;
    this.code = code;
  }
}

const sha256Hex = (dado) => crypto.createHash('sha256').update(dado).digest('hex');
const hmac = (chave, dado) => crypto.createHmac('sha256', chave).update(dado).digest();

/** Codificação da AWS: RFC 3986, com `!'()*` também codificados. */
export function awsEncode(texto) {
  return encodeURIComponent(texto).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** O caminho canônico: cada segmento codificado, as barras mantidas. */
export function encodePath(caminho) {
  return caminho.split('/').map(awsEncode).join('/');
}

/** A query canônica: pares codificados e em ordem de chave (e de valor). */
export function canonicalQuery(query = []) {
  const pares = Array.isArray(query) ? query : Object.entries(query);
  return pares
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [awsEncode(String(k)), awsEncode(String(v))])
    .sort(([ka, va], [kb, vb]) => (ka < kb ? -1 : ka > kb ? 1 : va < vb ? -1 : va > vb ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** A chave de assinatura do dia — `kSigning` da documentação da AWS. */
export function signingKey(secretAccessKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** `20130524T000000Z` a partir de uma data. */
export function amzDate(data = new Date()) {
  return data.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * A assinatura SigV4 de uma requisição.
 *
 * `path` já vem CODIFICADO (é o que vai na URL e o que entra no canônico — os
 * dois têm de ser o mesmo texto, ou o servidor calcula outra assinatura).
 * `headers` em minúsculas; todos entram na assinatura.
 */
export function signV4({
  method, path, query = [], headers, payloadHash, region, service = 's3',
  accessKeyId, secretAccessKey, date
}) {
  const quando = date ?? headers['x-amz-date'];
  const dia = quando.slice(0, 8);
  const nomes = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const porNome = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = nomes
    .map((h) => `${h}:${String(porNome[h]).trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const signedHeaders = nomes.join(';');
  const canonicalRequest = [
    method, path, canonicalQuery(query), canonicalHeaders, signedHeaders, payloadHash
  ].join('\n');
  const scope = `${dia}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', quando, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(secretAccessKey, dia, region, service), stringToSign).toString('hex');
  return {
    canonicalRequest,
    stringToSign,
    signature,
    signedHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  };
}

/** O primeiro `<Tag>valor</Tag>` de um XML pequeno — o S3 só responde XML simples. */
function xmlValue(xml, tag) {
  const m = String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXml(m[1]) : null;
}

function decodeXml(texto) {
  return texto.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

const escapeXml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Um passa-tudo que conta bytes e calcula o sha256 do que passou. */
export function hashingStream() {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const t = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    }
  });
  t.result = () => ({ sha256: hash.digest('hex'), bytes });
  return t;
}

export class S3Client {
  /**
   * @param {object} cfg
   * @param {string} [cfg.endpoint] `https://s3.us-east-1.amazonaws.com`, `http://127.0.0.1:9000`…
   *   Sem ele, o endpoint regional da AWS.
   * @param {string} cfg.region
   * @param {string} cfg.bucket
   * @param {string} cfg.accessKeyId
   * @param {string} cfg.secretAccessKey
   * @param {boolean} [cfg.forcePathStyle]
   */
  constructor({
    endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle = false,
    fetchImpl = globalThis.fetch, multipartThreshold = MULTIPART_THRESHOLD, partSize = PART_SIZE,
    timeoutMs = 120_000, now = () => new Date()
  }) {
    if (!bucket || !accessKeyId || !secretAccessKey) throw new S3Error('Incomplete S3 configuration', { code: 'not_configured' });
    this.region = region || 'us-east-1';
    const base = endpoint ? String(endpoint).trim().replace(/\/+$/, '') : `https://s3.${this.region}.amazonaws.com`;
    let url;
    try {
      url = new URL(base);
    } catch {
      throw new S3Error('The S3 endpoint is not a valid URL', { code: 'invalid_endpoint' });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new S3Error('The S3 endpoint must be http or https', { code: 'invalid_endpoint' });
    }
    this.protocol = url.protocol;
    this.host = url.host;
    // Um endpoint com caminho (`https://host/s3`) é raro mas existe atrás de proxy.
    this.basePath = url.pathname.replace(/\/+$/, '');
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.forcePathStyle = Boolean(forcePathStyle);
    this.fetch = fetchImpl;
    this.multipartThreshold = multipartThreshold;
    this.partSize = partSize;
    this.timeoutMs = timeoutMs;
    this.now = now;
  }

  /** Host e caminho (codificado) de uma chave — ou do bucket, sem chave. */
  target(key = null) {
    const chave = key === null ? '' : encodePath(key);
    if (this.forcePathStyle) {
      return { host: this.host, path: `${this.basePath}/${awsEncode(this.bucket)}${key === null ? '' : `/${chave}`}` };
    }
    return { host: `${this.bucket}.${this.host}`, path: `${this.basePath}/${chave}` };
  }

  async request(method, key, { query = [], body = null, headers = {}, payloadHash = null, expect = [200] } = {}) {
    const { host, path } = this.target(key);
    const hash = payloadHash ?? (body ? sha256Hex(body) : EMPTY_SHA256);
    const assinados = {
      host,
      'x-amz-content-sha256': hash,
      'x-amz-date': amzDate(this.now()),
      ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]))
    };
    const { authorization } = signV4({
      method, path: path || '/', query, headers: assinados, payloadHash: hash, region: this.region,
      accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey
    });
    const qs = canonicalQuery(query);
    const url = `${this.protocol}//${host}${path || '/'}${qs ? `?${qs}` : ''}`;
    // `host` não vai nos cabeçalhos do fetch (é proibido lá): ele sai da URL,
    // igual ao assinado.
    const { host: _host, ...enviados } = assinados;
    let resposta;
    try {
      resposta = await this.fetch(url, {
        method,
        headers: { ...enviados, authorization },
        body: body ?? undefined,
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      throw new S3Error(`Could not reach the S3 endpoint (${error.cause?.code || error.name || 'network error'})`, { code: 'unreachable' });
    }
    if (!expect.includes(resposta.status)) {
      const texto = method === 'HEAD' ? '' : await resposta.text().catch(() => '');
      // O HEAD volta sem corpo: o código sai do status, que é o que o S3 quis dizer.
      const codigo = xmlValue(texto, 'Code')
        ?? (method === 'HEAD' ? ({ 403: 'AccessDenied', 404: key === null ? 'NoSuchBucket' : 'NoSuchKey', 301: 'PermanentRedirect' })[resposta.status] : null);
      const mensagem = xmlValue(texto, 'Message');
      throw new S3Error(
        `S3 answered ${resposta.status}${codigo ? ` ${codigo}` : ''}${mensagem ? `: ${mensagem}` : ''}`,
        { status: resposta.status, code: codigo === 'NoSuchKey' || resposta.status === 404 ? 'not_found' : 's3_error' }
      );
    }
    return resposta;
  }

  /** O bucket existe e estas credenciais o alcançam. */
  async headBucket() {
    await this.request('HEAD', null);
    return true;
  }

  /**
   * Envia um objeto. `body` é um Buffer; `filePath` é um arquivo, mandado em
   * uma requisição até `multipartThreshold` e em partes de `partSize` acima.
   * `metadata` vira `x-amz-meta-*` — onde vai o sha256 do arquivo cifrado.
   */
  async putObject(key, { body = null, filePath = null, metadata = {}, contentType = 'application/octet-stream' } = {}) {
    const meta = Object.fromEntries(Object.entries(metadata).map(([k, v]) => [`x-amz-meta-${k.toLowerCase()}`, String(v)]));
    if (body !== null) {
      const r = await this.request('PUT', key, { body, headers: { 'content-type': contentType, ...meta } });
      return { etag: r.headers.get('etag'), multipart: false };
    }
    // Um descritor só: o tamanho (`fstat`) e o conteúdo vêm do MESMO arquivo
    // aberto, e não de um caminho que pode ter sido trocado entre um e outro.
    const fh = await fs.promises.open(filePath, 'r');
    try {
      const tamanho = (await fh.stat()).size;
      if (tamanho <= this.multipartThreshold) {
        const conteudo = await fh.readFile();
        const r = await this.request('PUT', key, { body: conteudo, headers: { 'content-type': contentType, ...meta } });
        return { etag: r.headers.get('etag'), multipart: false };
      }
      return await this.multipartUpload(key, fh, tamanho, { 'content-type': contentType, ...meta });
    } finally {
      await fh.close();
    }
  }

  /** As partes saem de `fh`, já aberto por `putObject` (e fechado por ele). */
  async multipartUpload(key, fh, tamanho, headers) {
    const inicio = await this.request('POST', key, { query: [['uploads', '']], headers });
    const uploadId = xmlValue(await inicio.text(), 'UploadId');
    if (!uploadId) throw new S3Error('S3 did not return an UploadId', { code: 's3_error' });
    const partes = [];
    try {
      for (let numero = 1, posicao = 0; posicao < tamanho; numero += 1, posicao += this.partSize) {
        const n = Math.min(this.partSize, tamanho - posicao);
        const buf = Buffer.allocUnsafe(n);
        // eslint-disable-next-line no-await-in-loop -- uma parte por vez: a memória fica em `partSize`
        const { bytesRead } = await fh.read(buf, 0, n, posicao);
        if (bytesRead !== n) throw new S3Error('The file changed while it was being uploaded', { code: 's3_error' });
        // eslint-disable-next-line no-await-in-loop
        const r = await this.request('PUT', key, {
          query: [['partNumber', numero], ['uploadId', uploadId]], body: buf
        });
        partes.push({ numero, etag: r.headers.get('etag') });
      }
      const xml = `<CompleteMultipartUpload>${partes
        .map((p) => `<Part><PartNumber>${p.numero}</PartNumber><ETag>${escapeXml(p.etag ?? '')}</ETag></Part>`)
        .join('')}</CompleteMultipartUpload>`;
      const fim = await this.request('POST', key, {
        query: [['uploadId', uploadId]], body: Buffer.from(xml), headers: { 'content-type': 'application/xml' }
      });
      // O S3 pode responder 200 com um <Error> no corpo do Complete.
      const texto = await fim.text();
      if (/<Error>/.test(texto)) {
        throw new S3Error(`S3 refused to complete the upload: ${xmlValue(texto, 'Code') ?? 'error'}`, { code: 's3_error' });
      }
      return { etag: xmlValue(texto, 'ETag'), multipart: true, parts: partes.length };
    } catch (error) {
      // Uma subida pela metade é cobrada como armazenamento até alguém abortar.
      await this.request('DELETE', key, { query: [['uploadId', uploadId]], expect: [200, 204, 404] }).catch(() => {});
      throw error;
    }
  }

  /** Metadados de um objeto, ou nulo quando não existe. */
  async headObject(key) {
    let r;
    try {
      r = await this.request('HEAD', key);
    } catch (error) {
      if (error instanceof S3Error && error.status === 404) return null;
      throw error;
    }
    const metadata = {};
    for (const [k, v] of r.headers) if (k.startsWith('x-amz-meta-')) metadata[k.slice(11)] = v;
    return { size: Number(r.headers.get('content-length')), etag: r.headers.get('etag'), metadata };
  }

  /** Baixa para um arquivo, calculando o sha256 no caminho. */
  async getObjectToFile(key, filePath) {
    const r = await this.request('GET', key);
    const metadata = {};
    for (const [k, v] of r.headers) if (k.startsWith('x-amz-meta-')) metadata[k.slice(11)] = v;
    const contador = hashingStream();
    await pipeline(Readable.fromWeb(r.body), contador, fs.createWriteStream(filePath, { mode: 0o600 }));
    return { ...contador.result(), metadata };
  }

  /** Todos os objetos sob `prefix`, seguindo a paginação. */
  async listObjects(prefix = '') {
    const objetos = [];
    let token = null;
    for (let pagina = 0; pagina < 1000; pagina += 1) {
      const query = [['list-type', '2'], ['prefix', prefix]];
      if (token) query.push(['continuation-token', token]);
      // eslint-disable-next-line no-await-in-loop -- a próxima página depende do token desta
      const xml = await (await this.request('GET', null, { query })).text();
      for (const bloco of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        objetos.push({
          key: xmlValue(bloco, 'Key'),
          size: Number(xmlValue(bloco, 'Size') ?? 0),
          lastModified: xmlValue(bloco, 'LastModified'),
          etag: xmlValue(bloco, 'ETag')
        });
      }
      if (xmlValue(xml, 'IsTruncated') !== 'true') break;
      token = xmlValue(xml, 'NextContinuationToken');
      if (!token) break;
    }
    return objetos;
  }

  async deleteObject(key) {
    await this.request('DELETE', key, { expect: [200, 204] });
    return true;
  }
}
