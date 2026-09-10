import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { safeFetch } from '../src/utils/wa/ssrfGuard.js';
import { PinnedTransport } from '../src/utils/net/pinnedFetch.js';
import { EvolutionClient } from '../src/services/evolutionClient.js';

/**
 * Os dois limites que faltavam em toda requisição que o painel faz para fora.
 *
 * Nada aqui abre socket: o `globalThis.fetch` é trocado por um dublê. O que se
 * testa é o que o painel EXIGE do outro lado — um prazo e um teto — e nenhum
 * dos dois depende de rede para ser verificado.
 *
 * Um literal de IP, e não um nome. Um nome fazia `resolvesToPrivate` consultar
 * o DNS DE VERDADE (`dns.resolve4`/`resolve6`, que vão à rede), contando que
 * ele não resolvesse. Numa máquina que devolve NXDOMAIN na hora isso passa
 * despercebido; num runner cujo resolvedor é lento ou engole a consulta, cada
 * chamada espera o próprio timeout — mais do que os 5 s do `setTimeout` abaixo,
 * que é o que segura o loop de eventos. O loop drena e o `node:test` cancela os
 * oito testes pendentes: `0 fail, 8 cancelled`, nunca uma asserção quebrada,
 * que é o que torna essa falha difícil de ler.
 *
 * `resolvesToPrivate` retorna cedo para um literal (`parseIPv4(h) !== null`),
 * então nenhuma consulta acontece. `203.0.113.10` é TEST-NET-3 e não cai em
 * nenhuma faixa de `isPrivateIPv4`, então o guard continua deixando passar —
 * que é o que põe o dublê no caminho.
 */
const HOST_PUBLICO = 'https://203.0.113.10';

let fetchReal;
let requestReal;

beforeEach(() => {
  fetchReal = globalThis.fetch;
  requestReal = PinnedTransport.request;
});

afterEach(() => {
  globalThis.fetch = fetchReal;
  PinnedTransport.request = requestReal;
});

describe('safeFetch gives every outbound request a deadline', () => {
  /**
   * O dublê ficava em `globalThis.fetch`, e não fica mais: o `safeFetch` não
   * passa mais por `fetch`. Ele não pode — o endereço aprovado tem de ser o
   * endereço conectado, e o `fetch` do Node não aceita resolvedor. O transporte
   * compartilhado (`utils/net/pinnedFetch.js`) é quem abre o socket, então é
   * nele que o dublê entra.
   *
   * O que se testa continua sendo o mesmo, e é o que o `safeFetch` faz EM VOLTA
   * do transporte: prazo único, sinal sempre presente, sinal do chamador
   * respeitado. Nada aqui abre socket, e `203.0.113.10` continua sendo um
   * literal — nenhuma consulta de nome acontece, em nenhum resolvedor.
   */
  function dubla(responder) {
    const chamadas = [];
    PinnedTransport.request = (opcoes) => {
      chamadas.push(opcoes);
      return responder(opcoes, chamadas.length);
    };
    return chamadas;
  }

  test('abandons a request that answers nothing at all', async () => {
    dubla(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    }));

    // O timer de `AbortSignal.timeout` é unref'd, e o dublê acima não abre
    // socket nenhum: sem algo segurando o loop de eventos o processo sairia
    // antes do prazo vencer. Em produção a conexão aberta faz esse papel.
    const segura = setTimeout(() => {}, 5_000);
    try {
      await assert.rejects(
        () => safeFetch(`${HOST_PUBLICO}/midia.png`, { timeoutMs: 60 }),
        (error) => error.name === 'TimeoutError'
      );
    } finally {
      clearTimeout(segura);
    }
  });

  test('passes a signal even when the caller gives none', async () => {
    const chamadas = dubla(() => new Response('ok', { status: 200 }));

    await safeFetch(`${HOST_PUBLICO}/midia.png`);
    assert.ok(chamadas[0].signal instanceof AbortSignal, 'toda saída tem de carregar um sinal');
    assert.equal(chamadas[0].signal.aborted, false);
  });

  /**
   * Um prazo só para a busca inteira, e não um por salto: três saltos com o
   * prazo cheio cada seriam o triplo da espera, que é justamente o que este
   * limite existe para evitar.
   */
  test('spends one deadline across every redirect hop', async () => {
    const chamadas = dubla((_opcoes, salto) => (salto < 3
      ? new Response(null, { status: 302, headers: { location: `${HOST_PUBLICO}/${salto}` } })
      : new Response('chegou', { status: 200 })));

    const resposta = await safeFetch(`${HOST_PUBLICO}/inicio`);
    assert.equal(resposta.status, 200);
    assert.equal(chamadas.length, 3);
    assert.equal(new Set(chamadas.map((c) => c.signal)).size, 1, 'os saltos compartilham um prazo, não um por salto');
  });

  /**
   * O prazo tem de valer da resolução do nome em diante, e não só do `fetch`.
   *
   * A verificação anti-SSRF consulta o DNS antes de abrir qualquer conexão, e
   * um resolver que não responde prende quem chamou tanto quanto um servidor
   * que não responde — mesma espera, mesmo handler preso, um passo antes. O
   * dublê abaixo é um resolver que nunca responde e que só solta quem espera
   * quando é cancelado, que é como o c-ares se comporta de verdade.
   */
  test('covers the name resolution, not just the request', async () => {
    // Um NOME, e não a constante do arquivo. A fase de resolução é o assunto
    // deste caso, e um literal de IP é o seu próprio endereço — se o host daqui
    // virar um literal, o dublê abaixo deixa de ser consultado e o teste passa
    // a afirmar coisa nenhuma sem nunca ficar vermelho.
    const HOST_COM_NOME = 'https://evo.provedor.test';
    // O seam mudou de lugar junto com o resolvedor: quem consulta agora é
    // `PinnedTransport.lookup`, que é `getaddrinfo` — o mesmo que o socket
    // usaria, e a razão de a verificação ter deixado de mentir. O dublê é um
    // resolvedor que nunca responde, que é o caso que o prazo tem de cobrir.
    const lookupReal = PinnedTransport.lookup;
    PinnedTransport.lookup = () => new Promise(() => {});

    let abriuSocket = false;
    PinnedTransport.request = () => {
      abriuSocket = true;
      return Promise.resolve(new Response('ok', { status: 200 }));
    };

    const segura = setTimeout(() => {}, 5_000);
    try {
      await assert.rejects(
        () => safeFetch(`${HOST_COM_NOME}/midia.png`, { timeoutMs: 60 }),
        // O prazo é o motivo de a chamada acabar. Uma consulta abandonada não
        // devolve endereço nenhum, e chamar isso de "não resolveu" — ou pior,
        // de "host privado" — diria ao operador uma coisa que não aconteceu.
        (error) => error.name === 'TimeoutError'
      );
    } finally {
      clearTimeout(segura);
      PinnedTransport.lookup = lookupReal;
    }

    assert.equal(abriuSocket, false, 'a requisição não chegou a sair');
  });

  test("honours the caller's own signal alongside the deadline", async () => {
    const doChamador = new AbortController();
    dubla(({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
      doChamador.abort(new Error('o chamador desistiu'));
    }));

    await assert.rejects(
      () => safeFetch(`${HOST_PUBLICO}/midia.png`, { signal: doChamador.signal }),
      (error) => error.message === 'o chamador desistiu'
    );
  });

  /**
   * O teto de corpo não mora mais em cada chamador: ele é um argumento do
   * transporte compartilhado. Quem baixa anexo passa o seu (25 MiB); quem não
   * diz nada recebe o padrão, dimensionado para resposta de API.
   */
  test('hands the transport a ceiling for the body, stated or default', async () => {
    const chamadas = dubla(() => new Response('ok', { status: 200 }));

    await safeFetch(`${HOST_PUBLICO}/midia.png`);
    assert.equal(Number.isFinite(chamadas[0].maxBytes), true, 'toda saída tem de carregar um teto');

    await safeFetch(`${HOST_PUBLICO}/video.mp4`, { maxBytes: 25 * 1024 * 1024 });
    assert.equal(chamadas[1].maxBytes, 25 * 1024 * 1024);
  });
});

/**
 * TLS deixou de ser opcional para o servidor Evolution.
 *
 * O `http:` existia para um Evolution de laboratório na mesma LAN, e essa
 * justificativa não sobrevive ao ssrfGuard: ele barra toda faixa privada, então
 * um alvo `http://` é por construção um host PÚBLICO na internet aberta. Toda
 * requisição de `send` leva credencial no header `apikey` — a chave global do
 * servidor em create/list/delete, o token da instância no resto.
 */
describe('the Evolution client requires TLS', () => {
  const comBase = (baseUrl) => new EvolutionClient({ baseUrl, allowedHosts: [] });

  test('refuses a cleartext target before any request leaves', async () => {
    let chamou = false;
    globalThis.fetch = () => { chamou = true; return new Response('{}'); };

    await assert.rejects(
      () => comBase('http://evo.provedor.test').probe('/'),
      (error) => error.code === 'insecure_base_url'
    );
    assert.equal(chamou, false, 'nada pode ir para a rede antes da recusa');
  });

  test('refuses it for the credentialed path too', async () => {
    const cliente = new EvolutionClient({
      baseUrl: 'http://evo.provedor.test',
      allowedHosts: [],
      adminKey: 'chave-global-do-servidor'
    });
    await assert.rejects(
      () => cliente.assertTarget(),
      (error) => error.code === 'insecure_base_url'
    );
  });

  test('accepts https', async () => {
    await comBase('https://evo.provedor.test').assertTarget();
  });
});

describe('the Evolution client refuses to buffer an unbounded response', () => {
  const cliente = () => new EvolutionClient({ baseUrl: HOST_PUBLICO, allowedHosts: [] });

  /** Bem acima de `MAX_RESPONSE_BYTES`; a maior resposta real da API é uma lista de instâncias. */
  const ENORME = 'A'.repeat(2 * 1024 * 1024);

  test('reads a normal answer exactly as before', async () => {
    globalThis.fetch = () => new Response(JSON.stringify({ version: '2.1.1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });

    const resultado = await cliente().probe('/');
    assert.equal(resultado.ok, true);
    assert.deepEqual(resultado.data, { version: '2.1.1' });
  });

  test('refuses a body that declares an oversized length', async () => {
    globalThis.fetch = () => new Response(ENORME, {
      status: 200,
      headers: { 'content-length': String(ENORME.length) }
    });

    const resultado = await cliente().probe('/');
    // A resposta continua sendo uma resposta: o status é o que explica o
    // problema, e é justamente ele que se perderia num parse estourado.
    assert.equal(resultado.status, 200);
    assert.equal(resultado.data, null);
  });

  /**
   * O caso que o `content-length` não pega: servidor que não declara tamanho,
   * ou que mente. O total corrido é o que fecha essa porta.
   */
  test('refuses a body that declares nothing and streams past the cap', async () => {
    globalThis.fetch = () => new Response(
      new ReadableStream({
        start(controller) {
          const pedaco = new TextEncoder().encode('A'.repeat(64 * 1024));
          for (let i = 0; i < 24; i += 1) controller.enqueue(pedaco);
          controller.close();
        }
      }),
      { status: 200 }
    );

    const resultado = await cliente().probe('/');
    assert.equal(resultado.data, null);
  });

  test('answers null rather than a fragment, so nothing acts on half a document', async () => {
    globalThis.fetch = () => new Response(`{"instances":["${ENORME}"]}`, { status: 200 });

    const resultado = await cliente().probe('/');
    assert.equal(resultado.data, null);
    assert.notEqual(typeof resultado.data, 'string');
  });
});
