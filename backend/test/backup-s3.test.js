import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  EMPTY_SHA256, S3Client, S3Error, encodePath, signV4, signingKey
} = await import('../src/services/backup/s3Client.js');
const { planRetention, stampOfKey, objectKeyFor, parseObjectKey } = await import('../src/services/backup/externalBackupService.js');
const { startFakeS3 } = await import('./helpers/fakeS3.js');

/**
 * O cliente S3 escrito à mão: a assinatura contra os vetores OFICIAIS da AWS,
 * e as chamadas do backup contra um S3 de mentira que confere a assinatura do
 * mesmo jeito que o de verdade — upload simples, multipart, listagem paginada,
 * download, metadados, exclusão — mais a conta da retenção.
 */

describe('SigV4, pelos vetores da documentação da AWS', () => {
  it('a chave de assinatura derivada (IAM, "Deriving the signing key")', () => {
    assert.equal(
      signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20120215', 'us-east-1', 'iam').toString('hex'),
      'f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d'
    );
  });

  it('get-vanilla (aws-sig-v4-test-suite)', () => {
    const r = signV4({
      method: 'GET', path: '/', headers: { host: 'example.amazonaws.com', 'x-amz-date': '20150830T123600Z' },
      payloadHash: EMPTY_SHA256, region: 'us-east-1', service: 'service',
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
    });
    assert.equal(r.signature, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    assert.equal(r.authorization,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, '
      + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  });

  // Os quatro exemplos de "Signature Calculations for the Authorization
  // Header: Transferring Payload in a Single Chunk" (Amazon S3 API Reference).
  const S3 = { region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };
  const host = 'examplebucket.s3.amazonaws.com';
  const data = '20130524T000000Z';

  it('GET Object (com Range)', () => {
    const r = signV4({
      ...S3, method: 'GET', path: '/test.txt', payloadHash: EMPTY_SHA256,
      headers: { host, range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': data }
    });
    assert.equal(r.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('PUT Object (com $ na chave e storage class)', () => {
    const hash = crypto.createHash('sha256').update('Welcome to Amazon S3.').digest('hex');
    assert.equal(hash, '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const r = signV4({
      ...S3, method: 'PUT', path: encodePath('/test$file.text'), payloadHash: hash,
      headers: {
        date: 'Fri, 24 May 2013 00:00:00 GMT', host, 'x-amz-content-sha256': hash,
        'x-amz-date': data, 'x-amz-storage-class': 'REDUCED_REDUNDANCY'
      }
    });
    assert.equal(encodePath('/test$file.text'), '/test%24file.text');
    assert.equal(r.signature, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  });

  it('GET Bucket Lifecycle (query sem valor)', () => {
    const r = signV4({
      ...S3, method: 'GET', path: '/', query: { lifecycle: '' }, payloadHash: EMPTY_SHA256,
      headers: { host, 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': data }
    });
    assert.equal(r.signature, 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  });

  it('GET Bucket (List Objects, query fora de ordem)', () => {
    const r = signV4({
      ...S3, method: 'GET', path: '/', query: [['prefix', 'J'], ['max-keys', '2']], payloadHash: EMPTY_SHA256,
      headers: { host, 'x-amz-content-sha256': EMPTY_SHA256, 'x-amz-date': data }
    });
    assert.equal(r.signature, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});

describe('o endereço', () => {
  it('estilo de caminho para o MinIO, virtual-hosted para a AWS', () => {
    const base = { bucket: 'meu-bucket', accessKeyId: 'a', secretAccessKey: 'b', region: 'sa-east-1' };
    const minio = new S3Client({ ...base, endpoint: 'http://minio.local:9000', forcePathStyle: true });
    assert.deepEqual(minio.target('a b/c.tar'), { host: 'minio.local:9000', path: '/meu-bucket/a%20b/c.tar' });
    const aws = new S3Client(base);
    assert.deepEqual(aws.target('x/y'), { host: 'meu-bucket.s3.sa-east-1.amazonaws.com', path: '/x/y' });
    assert.throws(() => new S3Client({ ...base, endpoint: 'ftp://x' }), S3Error);
  });
});

describe('contra um S3 de mentira', () => {
  const credenciais = { bucket: 'backups', accessKeyId: 'AKIATESTE0000001', secretAccessKey: 'segredo/do+teste=0001', region: 'us-east-1' };
  let fake;
  let base;
  let cliente;

  before(async () => {
    fake = await startFakeS3({ ...credenciais, pageSize: 3 });
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'skygp-s3-'));
    cliente = new S3Client({
      ...credenciais, endpoint: fake.url, forcePathStyle: true, multipartThreshold: 300_000, partSize: 100_000
    });
  });

  after(async () => {
    await fake.close();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('HeadBucket, PUT com metadados, HEAD, GET e DELETE', async () => {
    assert.equal(await cliente.headBucket(), true);
    const corpo = crypto.randomBytes(1000);
    const r = await cliente.putObject('pasta/ação (1).bin', { body: corpo, metadata: { 'skygp-sha256': 'abc' } });
    assert.equal(r.multipart, false);
    assert.deepEqual(fake.objects.get('pasta/ação (1).bin').body, corpo);
    const cabeca = await cliente.headObject('pasta/ação (1).bin');
    assert.equal(cabeca.size, 1000);
    assert.equal(cabeca.metadata['skygp-sha256'], 'abc');
    const destino = path.join(base, 'baixado');
    const baixado = await cliente.getObjectToFile('pasta/ação (1).bin', destino);
    assert.equal(baixado.sha256, crypto.createHash('sha256').update(corpo).digest('hex'));
    assert.deepEqual(fs.readFileSync(destino), corpo);
    await cliente.deleteObject('pasta/ação (1).bin');
    assert.equal(await cliente.headObject('pasta/ação (1).bin'), null);
  });

  it('arquivo acima do teto vai em multipart, na ordem, com os metadados', async () => {
    const arquivo = path.join(base, 'grande.bin');
    const conteudo = crypto.randomBytes(350_000);
    fs.writeFileSync(arquivo, conteudo);
    const r = await cliente.putObject('grande.bin', { filePath: arquivo, metadata: { 'skygp-key-id': 'k1' } });
    assert.equal(r.multipart, true);
    assert.equal(r.parts, 4);
    const guardado = fake.objects.get('grande.bin');
    assert.deepEqual(guardado.body, conteudo);
    assert.equal(guardado.metadata['skygp-key-id'], 'k1');
    const partes = fake.requests.filter((q) => q.method === 'PUT' && q.query.partNumber);
    assert.deepEqual(partes.map((q) => q.bytes), [100_000, 100_000, 100_000, 50_000]);
  });

  it('a parte que falha aborta a subida (nada fica cobrando armazenamento)', async () => {
    const arquivo = path.join(base, 'falha.bin');
    fs.writeFileSync(arquivo, crypto.randomBytes(320_000));
    fake.fail = (req, q) => (q.partNumber === '2' ? 500 : null);
    try {
      await assert.rejects(cliente.putObject('falha.bin', { filePath: arquivo }), S3Error);
    } finally {
      fake.fail = null;
    }
    assert.equal(fake.uploads.size, 0);
    assert.equal(fake.objects.has('falha.bin'), false);
  });

  it('a lista segue a paginação, e a credencial errada é recusada', async () => {
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await cliente.putObject(`lista/obj-${i}`, { body: Buffer.from(`x${i}`) });
    }
    const lista = await cliente.listObjects('lista/');
    assert.equal(lista.length, 7);
    assert.ok(fake.requests.filter((q) => q.query['continuation-token']).length >= 2);
    const errado = new S3Client({ ...credenciais, secretAccessKey: 'outro', endpoint: fake.url, forcePathStyle: true });
    await assert.rejects(errado.listObjects(''), (e) => e instanceof S3Error && /SignatureDoesNotMatch/.test(e.message));
  });
});

describe('a retenção', () => {
  const ESTA = 'a1b2c3d4e5f6';
  const OUTRA = '0f0e0d0c0b0a';
  const chave = (dia, hora = '031700', install = ESTA) => objectKeyFor('bk/', `${dia}T${hora}Z`, install);

  it('mantém o mais novo de cada um dos N dias e de cada uma das M semanas antes deles', () => {
    const objetos = [];
    // 40 dias seguidos, dois por dia no mais recente.
    for (let i = 0; i < 40; i += 1) {
      const d = new Date(Date.UTC(2026, 10, 3) - i * 86_400_000).toISOString().slice(0, 10);
      objetos.push({ key: chave(d) });
    }
    objetos.push({ key: chave('2026-11-03', '120000') });
    objetos.push({ key: 'bk/de-outra-pessoa.tar' }, { key: 'bk/sub/skygp-backup-2020-01-01T000000Z.tar.skygpbk' });
    const plano = planRetention(objetos, { prefix: 'bk/', keepDaily: 7, keepWeekly: 3, installId: ESTA });
    assert.equal(plano.keep.length, 10);
    assert.ok(plano.keep.includes(chave('2026-11-03', '120000')));
    assert.ok(!plano.keep.includes(chave('2026-11-03')), 'o segundo do mesmo dia sai');
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(Date.UTC(2026, 10, 3) - i * 86_400_000).toISOString().slice(0, 10);
      if (i > 0) assert.ok(plano.keep.includes(chave(d)), d);
    }
    // Nunca mexe no que não é nosso.
    assert.ok(!plano.remove.includes('bk/de-outra-pessoa.tar'));
    assert.ok(!plano.remove.some((k) => k.includes('/sub/')));
    assert.equal(plano.keep.length + plano.remove.length, 41);
    assert.equal(stampOfKey(chave('2026-11-03'), 'bk/'), '2026-11-03T031700Z');
    assert.equal(stampOfKey('outro/skygp-backup-2026-11-03T031700Z.tar.skygpbk', 'bk/'), null);
  });

  it('só poda o que ESTA instalação enviou: outra no mesmo prefixo, ou um objeto sem identidade, nunca sai', () => {
    const objetos = [];
    for (let i = 0; i < 30; i += 1) {
      const d = new Date(Date.UTC(2026, 10, 3) - i * 86_400_000).toISOString().slice(0, 10);
      objetos.push({ key: chave(d) }, { key: chave(d, '040000', OUTRA) }, { key: objectKeyFor('bk/', `${d}T050000Z`) });
    }
    const plano = planRetention(objetos, { prefix: 'bk/', keepDaily: 3, keepWeekly: 1, installId: ESTA });
    assert.equal(plano.keep.length, 4);
    assert.ok(plano.remove.length > 0);
    for (const k of [...plano.keep, ...plano.remove]) assert.ok(k.endsWith(`-${ESTA}.tar.skygpbk`), k);
    // E a outra instalação poda só os dela.
    const dela = planRetention(objetos, { prefix: 'bk/', keepDaily: 3, keepWeekly: 1, installId: OUTRA });
    for (const k of dela.remove) assert.ok(k.includes(`-${OUTRA}.`), k);
    // Sem identidade (ou uma inválida), nada sai.
    assert.deepEqual(planRetention(objetos, { prefix: 'bk/', keepDaily: 1, keepWeekly: 0 }).remove, []);
    assert.deepEqual(planRetention(objetos, { prefix: 'bk/', keepDaily: 1, keepWeekly: 0, installId: 'nao-hex' }).remove, []);
    // A chave guarda a identidade; quem pede a de outra não a reconhece.
    assert.equal(stampOfKey(chave('2026-11-03'), 'bk/', ESTA), '2026-11-03T031700Z');
    assert.equal(stampOfKey(chave('2026-11-03'), 'bk/', OUTRA), null);
    assert.equal(stampOfKey(objectKeyFor('bk/', '2026-11-03T031700Z'), 'bk/', ESTA), null);
    assert.deepEqual(parseObjectKey(chave('2026-11-03'), 'bk/'), { stamp: '2026-11-03T031700Z', installId: ESTA });
  });
});
