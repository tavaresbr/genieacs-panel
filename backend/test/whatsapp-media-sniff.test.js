import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTenant, startTestServers, stopTestServers } from './helpers/harness.js';

const { default: WaMediaService, setMediaFetcher } = await import('../src/services/waMediaService.js');

/**
 * Mídia recebida: o tipo vem do celular de quem escreveu. Quando os bytes não
 * batem com o tipo dito, o arquivo é guardado como binário genérico.
 */
before(async () => { await startTestServers(); });
after(async () => { setMediaFetcher(null); await stopTestServers(); });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const HTML = Buffer.from('<html><script>alert(1)</script></html>');

async function guarda(buf, mimetype, id) {
  setMediaFetcher(async () => ({ base64: buf.toString('base64'), mimetype }));
  return asTenant(() => WaMediaService.armazenar({
    account: { id: 1 },
    conversationId: 9001,
    externalId: id,
    dados: { key: { id } },
    mensagem: { imageMessage: { mimetype } }
  }));
}

describe('mídia recebida confere os bytes', () => {
  it('imagem de verdade segue como imagem', async () => {
    const r = await guarda(PNG, 'image/png', 'OK1');
    assert.equal(r.attachment_type, 'image/png');
    assert.match(r.attachment_name, /\.png$/);
  });

  it('HTML dito como imagem vira binário genérico, sem .png/.jpg', async () => {
    const r = await guarda(HTML, 'image/png', 'BAD1');
    assert.equal(r.attachment_type, 'application/octet-stream');
    assert.match(r.attachment_name, /\.bin$/);
  });
});
