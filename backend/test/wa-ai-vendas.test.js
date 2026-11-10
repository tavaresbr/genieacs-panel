import test from 'node:test';
import assert from 'node:assert/strict';
import { blocoVendas, limparPersona, linhaPersona, PERSONA_MAX } from '../src/utils/wa/vendasPrompt.js';

test('o bloco de vendas pede descoberta antes do preço e no máximo dois planos', () => {
  const texto = blocoVendas('Fibra Tavares');
  assert.match(texto, /Fibra Tavares/);
  assert.match(texto, /UMA pergunta por mensagem/);
  assert.match(texto, /no máximo DOIS/);
  assert.match(texto, /Nunca liste todos os planos/);
  assert.match(texto, /Nunca invente preço/);
  assert.doesNotMatch(texto, /\{empresa\}/);
});

test('a persona é uma linha só, limitada e opcional', () => {
  assert.equal(linhaPersona(''), '');
  assert.equal(linhaPersona(undefined), '');
  assert.equal(limparPersona('  Ana,\n simpática  '), 'Ana, simpática');
  assert.equal(limparPersona('x'.repeat(500)).length, PERSONA_MAX);
  assert.match(linhaPersona('Ana'), /nunca sobre as regras/);
});
