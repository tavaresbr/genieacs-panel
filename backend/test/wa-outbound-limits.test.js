import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { safeFetch } from '../src/utils/wa/ssrfGuard.js';
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

beforeEach(() => {
  fetchReal = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = fetchReal;
});

describe('safeFetch gives every outbound request a deadline', () => {
  /**
   * O `fetch` do Node não tem prazo nenhum por conta própria. Sem este, um host
   * que aceita a conexão e nunca responde prende o handler do webhook que
   * aguarda a busca — e `waWebhookLimiter` conta chegadas, não requisições
   * simultâneas, então nada limitava quantas ficavam presas ao mesmo tempo.
   */
  test('abandons a request that answers nothing at all', async () => {
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });

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
    let visto = null;
    globalThis.fetch = (_url, init) => {
      visto = init.signal;
      return new Response('ok', { status: 200 });
    };

    await safeFetch(`${HOST_PUBLICO}/midia.png`);
    assert.ok(visto instanceof AbortSignal, 'toda saída tem de carregar um sinal');
    assert.equal(visto.aborted, false);
  });

  /**
   * Um prazo só para a busca inteira, e não um por salto: três saltos com o
   * prazo cheio cada seriam o triplo da espera, que é justamente o que este
   * limite existe para evitar.
   */
  test('spends one deadline across every redirect hop', async () => {
    const sinais = new Set();
    let saltos = 0;
    globalThis.fetch = (_url, init) => {
      sinais.add(init.signal);
      saltos += 1;
      return saltos < 3
        ? new Response(null, { status: 302, headers: { location: `${HOST_PUBLICO}/${saltos}` } })
        : new Response('chegou', { status: 200 });
    };

    const resposta = await safeFetch(`${HOST_PUBLICO}/inicio`);
    assert.equal(resposta.status, 200);
    assert.equal(saltos, 3);
    assert.equal(sinais.size, 1, 'os saltos compartilham um prazo, não um por salto');
  });

  test("honours the caller's own signal alongside the deadline", async () => {
    const doChamador = new AbortController();
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
      doChamador.abort(new Error('o chamador desistiu'));
    });

    await assert.rejects(
      () => safeFetch(`${HOST_PUBLICO}/midia.png`, { signal: doChamador.signal }),
      (error) => error.message === 'o chamador desistiu'
    );
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
