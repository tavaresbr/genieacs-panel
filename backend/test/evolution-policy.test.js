import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvoUrl } from '../src/utils/wa/evolutionPolicy.js';

/**
 * `normalizeEvoUrl` recebe o que o operador digita, e as três expressões
 * regulares que ela tinha (`/\/+$/` duas vezes e `/\/manager(\/.*)?$/i`) ficam
 * quadráticas numa URL cheia de barras (CodeQL: "Polynomial regular expression
 * used on uncontrolled data"). A versão nova é linear; o que esta suíte prende é
 * que ela continua devolvendo EXATAMENTE o que a antiga devolvia.
 */

/** A implementação antiga, palavra por palavra: é o gabarito. */
function legacy(raw) {
  return String(raw || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/manager(\/.*)?$/i, '')
    .replace(/\/+$/, '');
}

describe('normalizeEvoUrl', () => {
  it('os casos de sempre', () => {
    assert.equal(normalizeEvoUrl('https://evo.exemplo.com/'), 'https://evo.exemplo.com');
    assert.equal(normalizeEvoUrl('  https://evo.exemplo.com///  '), 'https://evo.exemplo.com');
    assert.equal(normalizeEvoUrl('https://evo.exemplo.com/manager'), 'https://evo.exemplo.com');
    assert.equal(normalizeEvoUrl('https://evo.exemplo.com/Manager/instances'), 'https://evo.exemplo.com');
    assert.equal(normalizeEvoUrl('https://evo.exemplo.com/api/manager/'), 'https://evo.exemplo.com/api');
    // `/manager` só conta como segmento inteiro.
    assert.equal(normalizeEvoUrl('https://evo.exemplo.com/managers'), 'https://evo.exemplo.com/managers');
    assert.equal(normalizeEvoUrl('https://evo.exemplo.com/managerx/manager'), 'https://evo.exemplo.com/managerx');
    assert.equal(normalizeEvoUrl(''), '');
    assert.equal(normalizeEvoUrl(null), '');
    assert.equal(normalizeEvoUrl(undefined), '');
  });

  it('dá o mesmo resultado da versão antiga em milhares de entradas', () => {
    const alphabet = ['/', '/', 'm', 'M', 'a', 'n', 'g', 'e', 'r', 'A', 'x', ' ', 'h', ':', '.', 'İ', '\n', '\r', '\u2028'];
    // Gerador determinístico: a suíte tem de falhar sempre do mesmo jeito.
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pieces = ['/manager', '/Manager/', '/MANAGER/x', 'http://h', '//', '/managerx', '/mana', '/ manager'];
    for (let i = 0; i < 30000; i += 1) {
      let text = '';
      const length = Math.floor(next() * 26);
      for (let j = 0; j < length; j += 1) {
        text += next() < 0.15 ? pieces[Math.floor(next() * pieces.length)] : alphabet[Math.floor(next() * alphabet.length)];
      }
      assert.equal(normalizeEvoUrl(text), legacy(text), JSON.stringify(text));
    }
  });

  it('não trava numa URL feita para travar expressão regular', () => {
    const hostil = [
      `${'/'.repeat(200_000)}x`,
      `x${'/'.repeat(200_000)}`,
      '/manager'.repeat(30_000),
      `${'/manager'.repeat(30_000)}x`,
      `${'/mana'.repeat(40_000)}`
    ];
    for (const text of hostil) {
      const started = process.hrtime.bigint();
      normalizeEvoUrl(text);
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      assert.ok(ms < 250, `levou ${ms.toFixed(0)} ms`);
    }
  });
});
