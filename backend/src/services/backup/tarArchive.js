import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

/**
 * Um `tar` (ustar + pax) mínimo, em Node.
 *
 * Por que não o `tar` do sistema: a imagem Docker é Alpine (o `tar` é o do
 * busybox, com outras opções), a instalação própria tem o GNU, e o teste da
 * restauração roda em qualquer lugar. Um empacotador de 150 linhas que só sabe
 * arquivos e diretórios é a mesma saída nos três — e é o formato padrão: o
 * GNU tar lê o que sai daqui (`tar -tf`), e daqui se lê o que ele escreve, para
 * os tipos que um backup tem.
 *
 * Nomes longos e arquivos de mais de 8 GiB vão num cabeçalho pax (`x`), como
 * faz o GNU tar com `--format=pax`.
 */

const BLOCO = 512;
const MAX_OCTAL_SIZE = 0o77777777777;

function octal(valor, largura) {
  const texto = Math.floor(valor).toString(8);
  return `${texto.padStart(largura - 1, '0')}\0`;
}

function cabecalho({ name, size, mode, mtime, type }) {
  const h = Buffer.alloc(BLOCO);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(Math.min(size, MAX_OCTAL_SIZE), 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let soma = 0;
  for (const b of h) soma += b;
  h.write(`${soma.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

function registroPax(chave, valor) {
  // "<len> chave=valor\n", onde <len> conta a si mesmo.
  const corpo = ` ${chave}=${valor}\n`;
  let n = Buffer.byteLength(corpo) + 1;
  while (String(n).length + Buffer.byteLength(corpo) !== n) n = String(n).length + Buffer.byteLength(corpo);
  return `${n}${corpo}`;
}

function enchimento(tamanho) {
  const resto = tamanho % BLOCO;
  return resto ? Buffer.alloc(BLOCO - resto) : null;
}

function* cabecalhos(entrada) {
  const nome = entrada.type === '5' && !entrada.name.endsWith('/') ? `${entrada.name}/` : entrada.name;
  const pax = [];
  if (Buffer.byteLength(nome) > 99) pax.push(registroPax('path', nome));
  if (entrada.size > MAX_OCTAL_SIZE) pax.push(registroPax('size', entrada.size));
  if (pax.length) {
    const corpo = Buffer.from(pax.join(''), 'utf8');
    yield cabecalho({ name: 'PaxHeader', size: corpo.length, mode: 0o644, mtime: entrada.mtime, type: 'x' });
    yield corpo;
    const p = enchimento(corpo.length);
    if (p) yield p;
  }
  yield cabecalho({ ...entrada, name: Buffer.byteLength(nome) > 99 ? Buffer.from(nome).subarray(0, 99).toString('utf8') : nome });
}

/** Lista o que vai no arquivo: o diretório, depois o que há dentro, em ordem. */
async function percorrer(raiz, nomeNoArquivo, saida) {
  const st = await fs.promises.lstat(raiz);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    saida.push({ origem: raiz, name: nomeNoArquivo, type: '5', size: 0, mode: st.mode & 0o7777, mtime: st.mtimeMs / 1000 });
    const filhos = (await fs.promises.readdir(raiz)).sort();
    for (const filho of filhos) {
      // eslint-disable-next-line no-await-in-loop -- em ordem, para o arquivo sair sempre igual
      await percorrer(path.join(raiz, filho), `${nomeNoArquivo}/${filho}`, saida);
    }
  } else if (st.isFile()) {
    saida.push({ origem: raiz, name: nomeNoArquivo, type: '0', size: st.size, mode: st.mode & 0o7777, mtime: st.mtimeMs / 1000 });
  }
}

/**
 * Um `Readable` com o tar de `dir`, cujo nome dentro do arquivo é `nome`
 * (o carimbo do backup: `2026-11-03T031700Z/manifest.json`…). Links
 * simbólicos ficam de fora — um backup que segue link copia o que não é dele.
 */
export function packDirectory(dir, nome = path.basename(dir)) {
  async function* gerar() {
    const entradas = [];
    await percorrer(dir, nome, entradas);
    for (const entrada of entradas) {
      yield* cabecalhos(entrada);
      if (entrada.type !== '0') continue;
      let lidos = 0;
      for await (const pedaco of fs.createReadStream(entrada.origem)) {
        lidos += pedaco.length;
        if (lidos > entrada.size) throw new Error(`${entrada.name} grew while it was being archived`);
        yield pedaco;
      }
      if (lidos !== entrada.size) throw new Error(`${entrada.name} changed size while it was being archived`);
      const p = enchimento(entrada.size);
      if (p) yield p;
    }
    yield Buffer.alloc(BLOCO * 2);
  }
  return Readable.from(gerar(), { objectMode: false });
}

function lerOctal(buf, inicio, largura) {
  const texto = buf.toString('ascii', inicio, inicio + largura).replace(/\0.*$/, '').trim();
  return texto ? parseInt(texto, 8) : 0;
}

function lerPax(corpo) {
  const campos = {};
  let pos = 0;
  while (pos < corpo.length) {
    const espaco = corpo.indexOf(0x20, pos);
    if (espaco < 0) break;
    const n = Number(corpo.toString('ascii', pos, espaco));
    if (!n || pos + n > corpo.length) break;
    const registro = corpo.toString('utf8', espaco + 1, pos + n - 1);
    const igual = registro.indexOf('=');
    if (igual > 0) campos[registro.slice(0, igual)] = registro.slice(igual + 1);
    pos += n;
  }
  return campos;
}

/** Um nome de dentro do arquivo, como caminho seguro sob `destino` — ou erro. */
function caminhoSeguro(destino, nome) {
  const normalizado = path.posix.normalize(nome.replace(/\\/g, '/'));
  if (normalizado.startsWith('/') || normalizado === '..' || normalizado.startsWith('../') || normalizado.includes('/../')) {
    throw new Error(`Refusing archive entry outside the destination: ${nome}`);
  }
  const final = path.resolve(destino, normalizado);
  if (final !== destino && !final.startsWith(`${destino}${path.sep}`)) {
    throw new Error(`Refusing archive entry outside the destination: ${nome}`);
  }
  return final;
}

/**
 * Extrai um tar de um fluxo para `destino`. Só arquivos e diretórios; o resto
 * é pulado. Recusa nome absoluto e `..` — o arquivo vem de um bucket, e um
 * restore não pode escrever fora da pasta dele.
 *
 * @returns {Promise<string[]>} os caminhos (relativos) dos arquivos extraídos
 */
export async function extractTar(fluxo, destino) {
  const raiz = path.resolve(destino);
  await fs.promises.mkdir(raiz, { recursive: true });
  const extraidos = [];
  let pendente = Buffer.alloc(0);
  let atual = null;
  let pax = null;
  let terminou = false;

  const precisa = async (n, iterador) => {
    while (pendente.length < n) {
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await iterador.next();
      if (done) return false;
      pendente = pendente.length ? Buffer.concat([pendente, value]) : value;
    }
    return true;
  };

  const iterador = fluxo[Symbol.asyncIterator]();
  while (!terminou) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await precisa(BLOCO, iterador))) throw new Error('The archive ends without its end marker');
    const h = pendente.subarray(0, BLOCO);
    pendente = pendente.subarray(BLOCO);
    if (h.every((b) => b === 0)) {
      terminou = true;
      break;
    }
    const tipo = String.fromCharCode(h[156] || 48);
    let nome = h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const prefixo = h.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    if (prefixo) nome = `${prefixo}/${nome}`;
    let tamanho = lerOctal(h, 124, 12);
    const modo = lerOctal(h, 100, 8) & 0o777;
    if (pax?.path) nome = pax.path;
    if (pax?.size) tamanho = Number(pax.size);
    pax = null;
    const padding = tamanho % BLOCO ? BLOCO - (tamanho % BLOCO) : 0;

    if (tipo === 'x' || tipo === 'g') {
      // eslint-disable-next-line no-await-in-loop
      if (!(await precisa(tamanho + padding, iterador))) throw new Error('The archive ends inside a pax header');
      const campos = lerPax(pendente.subarray(0, tamanho));
      pendente = pendente.subarray(tamanho + padding);
      if (tipo === 'x') pax = campos;
      continue;
    }
    const alvo = caminhoSeguro(raiz, nome);
    if (tipo === '5') {
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.mkdir(alvo, { recursive: true, mode: 0o700 });
    }
    let fd = null;
    if (tipo === '0' || tipo === '\0') {
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.mkdir(path.dirname(alvo), { recursive: true, mode: 0o700 });
      // eslint-disable-next-line no-await-in-loop
      fd = await fs.promises.open(alvo, 'w', (modo & 0o700) | 0o600);
      extraidos.push(path.relative(raiz, alvo));
    }
    atual = { fd, falta: tamanho + padding, dados: tamanho };
    while (atual.falta > 0) {
      if (!pendente.length) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await precisa(1, iterador))) throw new Error(`The archive ends inside ${nome}`);
      }
      const n = Math.min(atual.falta, pendente.length);
      const pedaco = pendente.subarray(0, n);
      pendente = pendente.subarray(n);
      const util = Math.min(n, atual.dados);
      if (atual.fd && util > 0) {
        // eslint-disable-next-line no-await-in-loop
        await atual.fd.write(pedaco.subarray(0, util));
      }
      atual.dados -= util;
      atual.falta -= n;
    }
    // eslint-disable-next-line no-await-in-loop
    if (atual.fd) await atual.fd.close();
    atual = null;
  }
  // Consome o resto (o segundo bloco de zeros e o enchimento do registro).
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done } = await iterador.next();
    if (done) break;
  }
  return extraidos;
}
