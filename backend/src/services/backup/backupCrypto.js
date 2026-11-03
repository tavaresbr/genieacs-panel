import crypto from 'node:crypto';
import { Transform } from 'node:stream';

/**
 * A cifra do backup externo — com uma chave que NÃO fica no servidor.
 *
 * ## O modelo
 *
 * Criptografia de chave pública, para que o servidor consiga CIFRAR todo dia e
 * nunca consiga DECIFRAR. No servidor fica só a chave pública X25519; a
 * privada nasce no navegador de quem opera (ou, sem WebCrypto, no backend, que
 * a devolve uma vez e não a guarda) e vai para um cofre fora dele. Quem invade
 * o servidor e o bucket leva arquivos que não abre — que é o ponto de tirar o
 * backup da máquina: o dia em que ele é necessário é, muitas vezes, o dia em
 * que a máquina foi comprometida.
 *
 * ## A conta, por arquivo
 *
 * 1. Um par X25519 EFÊMERO, novo a cada arquivo; o segredo compartilhado é o
 *    ECDH entre a efêmera e a pública do destinatário.
 * 2. HKDF-SHA256 sobre esse segredo, com um sal aleatório e, na `info`, as
 *    duas públicas — chave AES de 32 bytes e um prefixo de nonce de 7.
 * 3. AES-256-GCM em pedaços de `chunkSize` (64 KiB), cada um com tag própria.
 *    O nonce é `prefixo(7) || contador(4, BE) || último(1)`: o contador impede
 *    trocar a ordem dos pedaços, e o byte de "último" impede TRUNCAR — um
 *    arquivo cortado exatamente na fronteira de um pedaço termina num pedaço
 *    que foi selado como "não último", e a tag dele não fecha. O cabeçalho
 *    inteiro entra como AAD de todo pedaço.
 *
 * É a construção STREAM (Hoang, Reyhanitabar, Rogaway, Vizár), a mesma ideia do
 * `age`: sem dependência nova, só `node:crypto`, e a memória não cresce com o
 * tamanho do dump — um pedaço por vez.
 *
 * Uma chave por arquivo, então o contador começando do zero nunca repete um
 * nonce sob a mesma chave.
 *
 * ## O cabeçalho (68 bytes)
 *
 * | bytes | campo                                               |
 * |-------|-----------------------------------------------------|
 * | 7     | `SKYGPBK` (mágica)                                   |
 * | 1     | versão do formato (1)                                |
 * | 32    | pública efêmera (X25519, bruta)                     |
 * | 8     | id da chave do destinatário (sha256 da pública)     |
 * | 4     | tamanho do pedaço em claro (uint32 BE)              |
 * | 16    | sal do HKDF                                          |
 *
 * Depois, os pedaços: `cifrado || tag(16)`, todos de `chunkSize + 16` bytes
 * menos o último, que tem de 16 a `chunkSize + 16`.
 */

export const MAGIC = Buffer.from('SKYGPBK', 'ascii');
export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 7 + 1 + 32 + 8 + 4 + 16;
export const TAG_BYTES = 16;
export const DEFAULT_CHUNK_SIZE = 64 * 1024;
const MIN_CHUNK = 1024;
const MAX_CHUNK = 16 * 1024 * 1024;
const HKDF_INFO = Buffer.from('skygenpanel-backup-v1', 'ascii');

/** O prefixo do texto da chave pública, para a colagem errada se denunciar. */
export const PUBLIC_KEY_PREFIX = 'skygp-backup-pub-1:';

export class BackupCryptoError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.name = 'BackupCryptoError';
    this.code = code;
  }
}

/** O id da chave: os 8 primeiros bytes do sha256 da pública bruta. */
export function keyIdOf(rawPublic) {
  return crypto.createHash('sha256').update(rawPublic).digest().subarray(0, 8);
}

/** O id da chave em hex, como a tela e o manifesto o mostram. */
export function keyIdHex(rawPublic) {
  return keyIdOf(rawPublic).toString('hex');
}

function publicKeyObjectFromRaw(raw) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw.toString('base64url') }, format: 'jwk' });
}

function rawFromPublicKeyObject(objeto) {
  const jwk = objeto.export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url');
}

/**
 * A chave pública em qualquer das formas aceitas, normalizada.
 *
 * Aceita o texto `skygp-backup-pub-1:<base64url>` (o que a tela grava e
 * mostra), os 32 bytes em base64/base64url sem prefixo, um PEM SPKI e um JWK.
 *
 * @returns {{ raw: Buffer, text: string, keyId: string, keyObject: crypto.KeyObject }}
 */
export function parsePublicKey(entrada) {
  if (entrada && typeof entrada === 'object' && !Buffer.isBuffer(entrada) && entrada.kty) {
    return parsePublicKey(JSON.stringify(entrada));
  }
  const texto = Buffer.isBuffer(entrada) ? entrada.toString('utf8') : String(entrada ?? '');
  const limpo = texto.trim();
  if (!limpo) throw new BackupCryptoError('The public key is empty', 'invalid_public_key');
  let raw = null;
  try {
    if (limpo.startsWith('-----BEGIN')) {
      const objeto = crypto.createPublicKey({ key: limpo, format: 'pem' });
      if (objeto.asymmetricKeyType !== 'x25519') throw new Error('not x25519');
      raw = rawFromPublicKeyObject(objeto);
    } else if (limpo.startsWith('{')) {
      const jwk = JSON.parse(limpo);
      if (jwk.kty !== 'OKP' || jwk.crv !== 'X25519' || typeof jwk.x !== 'string') throw new Error('not x25519');
      raw = Buffer.from(jwk.x, 'base64url');
    } else {
      const corpo = limpo.startsWith(PUBLIC_KEY_PREFIX) ? limpo.slice(PUBLIC_KEY_PREFIX.length) : limpo;
      if (!/^[A-Za-z0-9_\-+/=]+$/.test(corpo)) throw new Error('not base64');
      raw = Buffer.from(corpo.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url');
    }
  } catch {
    throw new BackupCryptoError('The public key is not an X25519 key', 'invalid_public_key');
  }
  if (raw.length !== 32) throw new BackupCryptoError('The public key is not an X25519 key', 'invalid_public_key');
  let keyObject;
  try {
    keyObject = publicKeyObjectFromRaw(raw);
  } catch {
    throw new BackupCryptoError('The public key is not an X25519 key', 'invalid_public_key');
  }
  // Recusada já na gravação, e não no primeiro backup da madrugada: uma
  // pública de ordem baixa faria todo arquivo sair com uma chave conhecida.
  const teste = ecdh(crypto.generateKeyPairSync('x25519').privateKey, keyObject);
  if (teste.every((b) => b === 0)) throw new BackupCryptoError('The public key is a low-order point', 'invalid_public_key');
  return { raw, text: `${PUBLIC_KEY_PREFIX}${raw.toString('base64url')}`, keyId: keyIdHex(raw), keyObject };
}

/**
 * A chave privada: PEM PKCS#8 (o que o navegador exporta e o `keygen` grava)
 * ou JWK com `d`.
 *
 * @returns {{ keyObject: crypto.KeyObject, raw: Buffer, keyId: string }}
 */
export function parsePrivateKey(entrada) {
  const texto = Buffer.isBuffer(entrada) ? entrada.toString('utf8') : String(entrada ?? '');
  let objeto;
  try {
    const limpo = texto.trim();
    // Um arquivo com comentário em volta (o que a tela baixa diz o que ele é):
    // vale o bloco PEM, onde quer que esteja.
    const pem = limpo.match(/-----BEGIN PRIVATE KEY-----[\s\S]+?-----END PRIVATE KEY-----/);
    if (pem) objeto = crypto.createPrivateKey({ key: pem[0], format: 'pem' });
    else objeto = crypto.createPrivateKey({ key: JSON.parse(limpo), format: 'jwk' });
  } catch {
    throw new BackupCryptoError('The private key is not a PKCS#8 PEM or JWK X25519 key', 'invalid_private_key');
  }
  if (objeto.asymmetricKeyType !== 'x25519') {
    throw new BackupCryptoError('The private key is not an X25519 key', 'invalid_private_key');
  }
  const raw = rawFromPublicKeyObject(crypto.createPublicKey(objeto));
  return { keyObject: objeto, raw, keyId: keyIdHex(raw) };
}

/**
 * Um par novo. Só para a CLI e para o caminho sem WebCrypto do console: a
 * privada sai daqui uma vez e quem chamou é responsável por não guardá-la.
 */
export function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const raw = rawFromPublicKeyObject(publicKey);
  return {
    publicKey: `${PUBLIC_KEY_PREFIX}${raw.toString('base64url')}`,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    keyId: keyIdHex(raw)
  };
}

/** O ECDH, com a recusa do OpenSSL a um ponto de ordem baixa traduzida. */
function ecdh(privateKey, publicKey) {
  try {
    return crypto.diffieHellman({ privateKey, publicKey });
  } catch {
    throw new BackupCryptoError('The public key is a low-order point', 'invalid_public_key');
  }
}

function derivar(shared, salt, ephemeralRaw, recipientRaw) {
  // Um segredo compartilhado todo zero é o de uma pública de ordem baixa: quem
  // a gravou quer que todo arquivo saia com uma chave conhecida.
  if (shared.every((b) => b === 0)) {
    throw new BackupCryptoError('The public key is a low-order point', 'invalid_public_key');
  }
  const info = Buffer.concat([HKDF_INFO, ephemeralRaw, recipientRaw]);
  const material = Buffer.from(crypto.hkdfSync('sha256', shared, salt, info, 39));
  return { key: material.subarray(0, 32), prefix: material.subarray(32, 39) };
}

function nonce(prefix, contador, ultimo) {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(contador, 7);
  n[11] = ultimo ? 1 : 0;
  return n;
}

/** Lê o cabeçalho; lança no que não é deste formato. */
export function parseHeader(buffer) {
  if (!buffer || buffer.length < HEADER_BYTES) {
    throw new BackupCryptoError('The file is too short to be an encrypted backup', 'truncated');
  }
  if (!buffer.subarray(0, 7).equals(MAGIC)) {
    throw new BackupCryptoError('This is not an encrypted backup (bad magic)', 'bad_magic');
  }
  const version = buffer[7];
  if (version !== FORMAT_VERSION) {
    throw new BackupCryptoError(`Unsupported backup format version ${version}`, 'bad_version');
  }
  const chunkSize = buffer.readUInt32BE(48);
  if (chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK) {
    throw new BackupCryptoError('The header declares an invalid chunk size', 'bad_header');
  }
  return {
    version,
    ephemeral: Buffer.from(buffer.subarray(8, 40)),
    keyId: buffer.subarray(40, 48).toString('hex'),
    chunkSize,
    salt: Buffer.from(buffer.subarray(52, 68)),
    header: Buffer.from(buffer.subarray(0, HEADER_BYTES))
  };
}

/**
 * Confere a FORMA de um arquivo cifrado sem a chave privada: o cabeçalho e se
 * o tamanho total fecha com pedaços de `chunkSize + 16` mais um último de pelo
 * menos 16. É o que a verificação semanal consegue provar sozinha — junto com
 * o sha256 do arquivo cifrado guardado no envio.
 */
export function inspectEncrypted(headerBuffer, totalBytes) {
  const cabecalho = parseHeader(headerBuffer);
  const corpo = Number(totalBytes) - HEADER_BYTES;
  const registro = cabecalho.chunkSize + TAG_BYTES;
  if (!Number.isFinite(corpo) || corpo < TAG_BYTES) {
    throw new BackupCryptoError('The file ends before its first chunk', 'truncated');
  }
  const resto = corpo % registro;
  if (resto !== 0 && resto < TAG_BYTES) {
    throw new BackupCryptoError('The file size does not match its chunk layout', 'truncated');
  }
  return {
    version: cabecalho.version,
    keyId: cabecalho.keyId,
    chunkSize: cabecalho.chunkSize,
    chunks: Math.ceil(corpo / registro),
    plaintextBytes: corpo - Math.ceil(corpo / registro) * TAG_BYTES
  };
}

/** Junta pedaços em fila sem `concat` a cada chegada. */
class Fila {
  constructor() {
    this.partes = [];
    this.length = 0;
  }

  push(buf) {
    if (buf.length) {
      this.partes.push(buf);
      this.length += buf.length;
    }
  }

  take(n) {
    const saida = Buffer.allocUnsafe(n);
    let escrito = 0;
    while (escrito < n) {
      const primeira = this.partes[0];
      const falta = n - escrito;
      if (primeira.length <= falta) {
        primeira.copy(saida, escrito);
        escrito += primeira.length;
        this.partes.shift();
      } else {
        primeira.copy(saida, escrito, 0, falta);
        this.partes[0] = primeira.subarray(falta);
        escrito += falta;
      }
    }
    this.length -= n;
    return saida;
  }

  rest() {
    return this.take(this.length);
  }
}

/**
 * O fluxo que cifra. Escreve o cabeçalho antes do primeiro pedaço e o último
 * pedaço (marcado) no fim — inclusive para uma entrada vazia, que vira um
 * arquivo com um pedaço vazio e uma tag, e não um arquivo sem fim definido.
 */
export function createEncryptStream(publicKey, { chunkSize = DEFAULT_CHUNK_SIZE } = {}) {
  if (!Number.isInteger(chunkSize) || chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK) {
    throw new BackupCryptoError('Invalid chunk size', 'bad_header');
  }
  const destinatario = typeof publicKey === 'object' && publicKey?.raw ? publicKey : parsePublicKey(publicKey);
  const efemera = crypto.generateKeyPairSync('x25519');
  const ephemeralRaw = rawFromPublicKeyObject(efemera.publicKey);
  const salt = crypto.randomBytes(16);
  const shared = ecdh(efemera.privateKey, destinatario.keyObject);
  const { key, prefix } = derivar(shared, salt, ephemeralRaw, destinatario.raw);

  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header[7] = FORMAT_VERSION;
  ephemeralRaw.copy(header, 8);
  keyIdOf(destinatario.raw).copy(header, 40);
  header.writeUInt32BE(chunkSize, 48);
  salt.copy(header, 52);

  const fila = new Fila();
  let contador = 0;
  let cabecalhoSaiu = false;

  const selar = (claro, ultimo) => {
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce(prefix, contador, ultimo));
    cipher.setAAD(header);
    const cifrado = Buffer.concat([cipher.update(claro), cipher.final(), cipher.getAuthTag()]);
    contador += 1;
    if (contador > 0xffffffff) throw new BackupCryptoError('The backup is too large for one file', 'too_large');
    return cifrado;
  };

  return new Transform({
    transform(chunk, _enc, done) {
      try {
        if (!cabecalhoSaiu) {
          this.push(header);
          cabecalhoSaiu = true;
        }
        fila.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        // Estritamente maior: o pedaço que fecha a entrada tem de ficar na
        // fila até o fim, porque só lá se sabe que ele é o último.
        while (fila.length > chunkSize) this.push(selar(fila.take(chunkSize), false));
        done();
      } catch (error) {
        done(error);
      }
    },
    flush(done) {
      try {
        if (!cabecalhoSaiu) this.push(header);
        this.push(selar(fila.rest(), true));
        done();
      } catch (error) {
        done(error);
      }
    }
  });
}

/**
 * O fluxo que decifra. Nenhum byte em claro sai antes de a tag do pedaço dele
 * fechar; um arquivo truncado, adulterado, reordenado, com bytes a mais no fim
 * ou cifrado para outra chave termina em erro (`BackupCryptoError`).
 */
export function createDecryptStream(privateKey) {
  const minha = typeof privateKey === 'object' && privateKey?.keyObject ? privateKey : parsePrivateKey(privateKey);
  const fila = new Fila();
  let estado = null;
  let contador = 0;

  const abrir = (registro, ultimo) => {
    const tag = registro.subarray(registro.length - TAG_BYTES);
    const corpo = registro.subarray(0, registro.length - TAG_BYTES);
    const decipher = crypto.createDecipheriv('aes-256-gcm', estado.key, nonce(estado.prefix, contador, ultimo));
    decipher.setAAD(estado.header);
    decipher.setAuthTag(tag);
    try {
      const claro = Buffer.concat([decipher.update(corpo), decipher.final()]);
      contador += 1;
      return claro;
    } catch {
      throw new BackupCryptoError(
        `Chunk ${contador} failed authentication: the file is corrupted, truncated or was tampered with`,
        'corrupt'
      );
    }
  };

  const iniciar = () => {
    const cabecalho = parseHeader(fila.take(HEADER_BYTES));
    if (cabecalho.keyId !== minha.keyId) {
      throw new BackupCryptoError(
        `This backup was encrypted for key ${cabecalho.keyId}, not for this private key (${minha.keyId})`,
        'wrong_key'
      );
    }
    const shared = ecdh(minha.keyObject, publicKeyObjectFromRaw(cabecalho.ephemeral));
    const { key, prefix } = derivar(shared, cabecalho.salt, cabecalho.ephemeral, minha.raw);
    estado = { ...cabecalho, key, prefix, registro: cabecalho.chunkSize + TAG_BYTES };
  };

  return new Transform({
    transform(chunk, _enc, done) {
      try {
        fila.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (!estado && fila.length >= HEADER_BYTES) iniciar();
        if (estado) {
          while (fila.length > estado.registro) this.push(abrir(fila.take(estado.registro), false));
        }
        done();
      } catch (error) {
        done(error);
      }
    },
    flush(done) {
      try {
        if (!estado) {
          if (fila.length >= HEADER_BYTES) iniciar();
          else throw new BackupCryptoError('The file ends inside its header', 'truncated');
        }
        if (fila.length < TAG_BYTES) {
          throw new BackupCryptoError('The file ends before its final chunk', 'truncated');
        }
        this.push(abrir(fila.rest(), true));
        done();
      } catch (error) {
        done(error);
      }
    }
  });
}

/** Cifra um buffer inteiro — para os testes e para o objeto de teste do bucket. */
export async function encryptBuffer(buffer, publicKey, opts) {
  return coletar(createEncryptStream(publicKey, opts), buffer);
}

export async function decryptBuffer(buffer, privateKey) {
  return coletar(createDecryptStream(privateKey), buffer);
}

function coletar(transform, entrada) {
  return new Promise((resolve, reject) => {
    const partes = [];
    transform.on('data', (p) => partes.push(p));
    transform.on('error', reject);
    transform.on('end', () => resolve(Buffer.concat(partes)));
    transform.end(entrada);
  });
}
