import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const {
  BackupCryptoError, HEADER_BYTES, TAG_BYTES, decryptBuffer, encryptBuffer, generateKeyPair,
  inspectEncrypted, parsePrivateKey, parsePublicKey
} = await import('../src/services/backup/backupCrypto.js');

/**
 * A cifra do backup externo (X25519 + HKDF-SHA256 + AES-256-GCM em pedaços):
 * ida e volta em todos os tamanhos que tocam uma fronteira de pedaço, e as
 * formas de estragar um arquivo — byte trocado, truncado no meio, truncado
 * EXATAMENTE na fronteira (o caso que o byte de "último pedaço" existe para
 * pegar), pedaços trocados de ordem, bytes a mais no fim, cabeçalho mexido e
 * a chave errada. Em todas, o resultado é erro, nunca dado.
 */

const RAIZ = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(RAIZ, 'scripts', 'backup-crypto.js');
const par = generateKeyPair();
const CHUNK = 1024;

async function falha(promessa, codigo) {
  await assert.rejects(promessa, (error) => {
    assert.ok(error instanceof BackupCryptoError, `esperava BackupCryptoError, veio ${error?.name}: ${error?.message}`);
    if (codigo) assert.equal(error.code, codigo);
    return true;
  });
}

describe('a cifra do backup', () => {
  it('ida e volta em todo tamanho perto de uma fronteira de pedaço', async () => {
    for (const n of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 3 * CHUNK + 17]) {
      const claro = crypto.randomBytes(n);
      // eslint-disable-next-line no-await-in-loop
      const cifrado = await encryptBuffer(claro, par.publicKey, { chunkSize: CHUNK });
      // eslint-disable-next-line no-await-in-loop
      assert.deepEqual(await decryptBuffer(cifrado, par.privateKeyPem), claro, `tamanho ${n}`);
      const forma = inspectEncrypted(cifrado.subarray(0, HEADER_BYTES), cifrado.length);
      assert.equal(forma.plaintextBytes, n);
      assert.equal(forma.keyId, par.keyId);
    }
  });

  it('dois arquivos do mesmo conteúdo não se parecem (chave efêmera por arquivo)', async () => {
    const claro = Buffer.alloc(3000, 1);
    const a = await encryptBuffer(claro, par.publicKey, { chunkSize: CHUNK });
    const b = await encryptBuffer(claro, par.publicKey, { chunkSize: CHUNK });
    assert.notDeepEqual(a.subarray(8, 40), b.subarray(8, 40));
    assert.notDeepEqual(a.subarray(HEADER_BYTES), b.subarray(HEADER_BYTES));
  });

  it('um byte trocado em qualquer pedaço não decifra', async () => {
    const cifrado = await encryptBuffer(crypto.randomBytes(3 * CHUNK), par.publicKey, { chunkSize: CHUNK });
    for (const pos of [HEADER_BYTES + 5, HEADER_BYTES + CHUNK + TAG_BYTES + 3, cifrado.length - 1]) {
      const mexido = Buffer.from(cifrado);
      mexido[pos] ^= 0x01;
      // eslint-disable-next-line no-await-in-loop
      await falha(decryptBuffer(mexido, par.privateKeyPem), 'corrupt');
    }
  });

  it('truncado na fronteira de um pedaço não passa por inteiro', async () => {
    const cifrado = await encryptBuffer(crypto.randomBytes(3 * CHUNK + 10), par.publicKey, { chunkSize: CHUNK });
    const registro = CHUNK + TAG_BYTES;
    // Dois pedaços inteiros: estruturalmente perfeito, só que o último foi
    // selado como "não último" — a tag não fecha com o byte de fim ligado.
    const cortado = cifrado.subarray(0, HEADER_BYTES + 2 * registro);
    assert.doesNotThrow(() => inspectEncrypted(cortado.subarray(0, HEADER_BYTES), cortado.length));
    await falha(decryptBuffer(cortado, par.privateKeyPem), 'corrupt');
    // No meio de um pedaço.
    await falha(decryptBuffer(cifrado.subarray(0, HEADER_BYTES + registro + 100), par.privateKeyPem), 'corrupt');
    // Antes do primeiro pedaço, e dentro do cabeçalho.
    await falha(decryptBuffer(cifrado.subarray(0, HEADER_BYTES + 3), par.privateKeyPem), 'truncated');
    await falha(decryptBuffer(cifrado.subarray(0, 20), par.privateKeyPem), 'truncated');
    assert.throws(() => inspectEncrypted(cifrado.subarray(0, HEADER_BYTES), HEADER_BYTES + registro + 5), /chunk layout/);
  });

  it('pedaços trocados de ordem, ou bytes a mais no fim, não decifram', async () => {
    const cifrado = await encryptBuffer(crypto.randomBytes(3 * CHUNK + 10), par.publicKey, { chunkSize: CHUNK });
    const registro = CHUNK + TAG_BYTES;
    const h = cifrado.subarray(0, HEADER_BYTES);
    const p = (i) => cifrado.subarray(HEADER_BYTES + i * registro, HEADER_BYTES + (i + 1) * registro);
    const trocado = Buffer.concat([h, p(1), p(0), cifrado.subarray(HEADER_BYTES + 2 * registro)]);
    await falha(decryptBuffer(trocado, par.privateKeyPem), 'corrupt');
    await falha(decryptBuffer(Buffer.concat([cifrado, Buffer.alloc(40)]), par.privateKeyPem), 'corrupt');
  });

  it('o cabeçalho mexido não decifra, e um que não é deste formato é recusado', async () => {
    const cifrado = await encryptBuffer(Buffer.from('dado'), par.publicKey, { chunkSize: CHUNK });
    const sal = Buffer.from(cifrado);
    sal[60] ^= 0xff;
    await falha(decryptBuffer(sal, par.privateKeyPem), 'corrupt');
    const magica = Buffer.from(cifrado);
    magica[0] = 0x41;
    await falha(decryptBuffer(magica, par.privateKeyPem), 'bad_magic');
    const versao = Buffer.from(cifrado);
    versao[7] = 9;
    await falha(decryptBuffer(versao, par.privateKeyPem), 'bad_version');
  });

  it('outra chave privada é recusada pelo id antes de qualquer conta', async () => {
    const cifrado = await encryptBuffer(Buffer.from('dado'), par.publicKey);
    await falha(decryptBuffer(cifrado, generateKeyPair().privateKeyPem), 'wrong_key');
  });

  it('aceita o par que o navegador gera (WebCrypto X25519: pública bruta, privada PKCS#8)', async () => {
    const { subtle } = crypto.webcrypto;
    const k = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
    const bruta = Buffer.from(await subtle.exportKey('raw', k.publicKey));
    const pkcs8 = Buffer.from(await subtle.exportKey('pkcs8', k.privateKey)).toString('base64');
    const pem = `# comentário que a tela põe no arquivo\n-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
    const publica = parsePublicKey(`skygp-backup-pub-1:${bruta.toString('base64url')}`);
    assert.equal(parsePrivateKey(pem).keyId, publica.keyId);
    const cifrado = await encryptBuffer(Buffer.from('do navegador'), publica.text);
    assert.equal((await decryptBuffer(cifrado, pem)).toString(), 'do navegador');
  });

  it('recusa chave pública que não é X25519, e o ponto de ordem baixa', async () => {
    assert.throws(() => parsePublicKey('skygp-backup-pub-1:abc'), BackupCryptoError);
    assert.throws(() => parsePublicKey('não é chave'), BackupCryptoError);
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'pem' });
    assert.throws(() => parsePublicKey(rsa), BackupCryptoError);
    assert.throws(() => parsePublicKey(`skygp-backup-pub-1:${Buffer.alloc(32).toString('base64url')}`), /low-order/);
    await falha(encryptBuffer(Buffer.from('x'), `skygp-backup-pub-1:${Buffer.alloc(32).toString('base64url')}`), 'invalid_public_key');
  });
});

describe('a CLI backup-crypto.js', () => {
  it('cifra, inspeciona e decifra arquivos; o arquivo adulterado sai com código 1 e sem saída', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-bkc-'));
    try {
      const chave = path.join(base, 'privada.pem');
      const gerado = spawnSync(process.execPath, [CLI, 'keygen', '--out', chave], { encoding: 'utf8' });
      assert.equal(gerado.status, 0, gerado.stderr);
      assert.equal(fs.statSync(chave).mode & 0o777, 0o600);
      const publica = gerado.stderr.match(/(skygp-backup-pub-1:\S+)/)[1];
      const claro = path.join(base, 'claro.bin');
      fs.writeFileSync(claro, crypto.randomBytes(200_000));
      const cifrado = path.join(base, 'b.skygpbk');
      execFileSync(process.execPath, [CLI, 'encrypt', '--public-key', publica, claro, cifrado]);
      const forma = JSON.parse(execFileSync(process.execPath, [CLI, 'inspect', cifrado], { encoding: 'utf8' }));
      assert.equal(forma.plaintextBytes, 200_000);
      const volta = path.join(base, 'volta.bin');
      execFileSync(process.execPath, [CLI, 'decrypt', '--private-key', chave, cifrado, volta]);
      assert.deepEqual(fs.readFileSync(volta), fs.readFileSync(claro));
      // Pela stdin/stdout, como no `| tar -x`.
      const pelaStdout = execFileSync(process.execPath, [CLI, 'decrypt', '--private-key', chave], { input: fs.readFileSync(cifrado) });
      assert.deepEqual(pelaStdout, fs.readFileSync(claro));

      const mexido = fs.readFileSync(cifrado);
      mexido[mexido.length - 30] ^= 1;
      fs.writeFileSync(cifrado, mexido);
      const r = spawnSync(process.execPath, [CLI, 'decrypt', '--private-key', chave, cifrado, path.join(base, 'ruim.bin')], { encoding: 'utf8' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /failed authentication/);
      assert.equal(fs.existsSync(path.join(base, 'ruim.bin')), false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
