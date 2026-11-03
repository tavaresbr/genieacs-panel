import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import {
  HEADER_BYTES, createDecryptStream, createEncryptStream, generateKeyPair, inspectEncrypted, parsePrivateKey, parsePublicKey
} from '../src/services/backup/backupCrypto.js';

/**
 * A cifra do backup na linha de comando — no host e no dia do restore.
 *
 *   node scripts/backup-crypto.js keygen --out chave-privada.pem
 *   node scripts/backup-crypto.js encrypt --public-key <arquivo|texto> [entrada] [saída]
 *   node scripts/backup-crypto.js decrypt --private-key <arquivo> [entrada] [saída]
 *   node scripts/backup-crypto.js inspect <arquivo>
 *
 * Sem entrada/saída, lê da stdin e escreve na stdout — para encadear com o
 * tar: `node scripts/backup-crypto.js decrypt --private-key k.pem b.skygpbk | tar -x`.
 *
 * Não importa nada do banco: roda numa máquina sem o painel, só com o Node e
 * este diretório — que é onde a chave privada deveria estar.
 *
 * O `decrypt` escreve na saída pedaço a pedaço, cada um só depois de a tag dele
 * fechar; se o arquivo estiver corrompido ou truncado, o comando termina com
 * código 1 — e o que já saiu é um prefixo autenticado, nunca dado adulterado.
 * Com arquivo de saída, a saída parcial é apagada.
 */

function argumentos(argv) {
  const opcoes = {};
  const posicionais = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const nome = a.slice(2);
      const proximo = argv[i + 1];
      if (proximo === undefined || proximo.startsWith('--')) opcoes[nome] = true;
      else {
        opcoes[nome] = proximo;
        i += 1;
      }
    } else posicionais.push(a);
  }
  return { opcoes, posicionais };
}

function lerChave(valor) {
  if (typeof valor !== 'string') throw new Error('missing key argument');
  return fs.existsSync(valor) ? fs.readFileSync(valor, 'utf8') : valor;
}

async function main() {
  const [verbo, ...resto] = process.argv.slice(2);
  const { opcoes, posicionais } = argumentos(resto);
  const [entrada, saida] = posicionais;

  if (verbo === 'keygen') {
    const par = generateKeyPair();
    const corpo = `# skygenpanel backup private key — key id ${par.keyId}\n# Keep it OFF the server. Whoever has it can read every backup.\n${par.privateKeyPem}`;
    if (typeof opcoes.out === 'string') {
      fs.writeFileSync(opcoes.out, corpo, { mode: 0o600, flag: 'wx' });
      process.stderr.write(`private key written to ${opcoes.out}\n`);
    } else process.stdout.write(corpo);
    process.stderr.write(`public key (paste into the console): ${par.publicKey}\n`);
    return;
  }
  if (verbo === 'inspect') {
    const alvo = entrada;
    if (!alvo) throw new Error('usage: backup-crypto.js inspect <file>');
    const fh = fs.openSync(alvo, 'r');
    const cabecalho = Buffer.alloc(HEADER_BYTES);
    fs.readSync(fh, cabecalho, 0, HEADER_BYTES, 0);
    fs.closeSync(fh);
    process.stdout.write(`${JSON.stringify(inspectEncrypted(cabecalho, fs.statSync(alvo).size), null, 2)}\n`);
    return;
  }
  if (verbo === 'public-key') {
    const chave = parsePrivateKey(lerChave(opcoes['private-key']));
    process.stdout.write(`skygp-backup-pub-1:${chave.raw.toString('base64url')}\n`);
    return;
  }
  let transform;
  if (verbo === 'encrypt') transform = createEncryptStream(parsePublicKey(lerChave(opcoes['public-key'])));
  else if (verbo === 'decrypt') transform = createDecryptStream(parsePrivateKey(lerChave(opcoes['private-key'])));
  else {
    process.stderr.write('usage: backup-crypto.js keygen|encrypt|decrypt|inspect|public-key (see the header of this file)\n');
    process.exitCode = 1;
    return;
  }
  const origem = entrada && entrada !== '-' ? fs.createReadStream(entrada) : process.stdin;
  const destino = saida && saida !== '-' ? fs.createWriteStream(saida, { mode: 0o600 }) : process.stdout;
  try {
    await pipeline(origem, transform, destino);
  } catch (error) {
    if (saida && saida !== '-') fs.rmSync(saida, { force: true });
    throw error;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`backup-crypto: ${error.message}\n`);
  process.exitCode = 1;
}
