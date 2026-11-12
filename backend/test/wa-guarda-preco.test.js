import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatarReais, valoresEmCentavos, valoresForaDaLista } from '../src/utils/wa/guardaDePreco.js';

describe('os valores em reais de um texto', () => {
  it('lê os jeitos de escrever preço', () => {
    assert.deepEqual(valoresEmCentavos('O plano custa R$ 89,90 por mês.'), [8990]);
    assert.deepEqual(valoresEmCentavos('por R$89,9'), [8990]);
    assert.deepEqual(valoresEmCentavos('R$ 1.299,90 à vista'), [129990]);
    assert.deepEqual(valoresEmCentavos('só R$ 90'), [9000]);
    assert.deepEqual(valoresEmCentavos('R$ 89.90'), [8990]);
    assert.deepEqual(valoresEmCentavos('fica 99 reais'), [9900]);
    assert.deepEqual(valoresEmCentavos('89,90 reais por mês'), [8990]);
    assert.deepEqual(valoresEmCentavos('de R$ 99,90 por R$ 79,90'), [9990, 7990]);
  });

  it('não confunde velocidade, data, telefone, horário nem zero com preço', () => {
    assert.deepEqual(valoresEmCentavos('Plano de 300 Mega, instalação até dia 15/11, ligue 93 98111-0001 às 18:30'), []);
    assert.deepEqual(valoresEmCentavos('instalação por R$ 0'), []);
    assert.deepEqual(valoresEmCentavos('sem valor aqui'), []);
    assert.deepEqual(valoresEmCentavos(null), []);
  });

  it('só barra o que não está na lista permitida', () => {
    const permitidos = new Set([8990, 6990]);
    assert.deepEqual(valoresForaDaLista('R$ 89,90 ou R$ 69,90', permitidos), []);
    assert.deepEqual(valoresForaDaLista('R$ 89,90 ou R$ 49,90', permitidos), [4990]);
    assert.deepEqual(valoresForaDaLista('R$ 90', permitidos), [9000], 'arredondar também é inventar');
    assert.deepEqual(valoresForaDaLista('R$ 49,90', []), [4990], 'sem catálogo nada vale');
    assert.equal(formatarReais(4990), 'R$ 49,90');
  });
});
