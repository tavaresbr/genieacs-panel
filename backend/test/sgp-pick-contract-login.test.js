import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { default: SgpService } = await import('../src/services/sgpService.js');

/**
 * Um cliente com dois contratos e duas ONTs: o ERP responde com o cliente
 * inteiro, e o login que a ONT reporta é o que diz de qual contrato ela é.
 */
const CONTRATOS = [
  { contract: '350', login: 'TA100.310', blocked: false, statusLabel: 'Ativo' },
  { contract: '351', login: 'TA100.310.1', blocked: false, statusLabel: 'Ativo' }
];

describe('pickContract com o login da ONT', () => {
  it('escolhe o contrato cujo login é o da ONT', () => {
    assert.equal(SgpService.pickContract(CONTRATOS, null, 'TA100.310.1').contract, '351');
    assert.equal(SgpService.pickContract(CONTRATOS, null, 'ta100.310').contract, '350');
  });

  it('o login vence o contrato já salvo (corrige vínculo errado)', () => {
    assert.equal(SgpService.pickContract(CONTRATOS, '350', 'TA100.310.1').contract, '351');
  });

  it('sem login que case, mantém o comportamento anterior', () => {
    assert.equal(SgpService.pickContract(CONTRATOS, '351', 'outro').contract, '351');
    assert.equal(SgpService.pickContract(CONTRATOS, null, null).contract, '350');
  });
});
