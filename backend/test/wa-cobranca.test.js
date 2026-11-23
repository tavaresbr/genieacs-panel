import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  VARIAVEIS_DE_COBRANCA,
  comoReal,
  comoDataBr,
  diasEntre,
  variaveisDeCobranca,
  renderCobranca,
  separarCodigos,
  modeloEhLembrete,
  variaveisDesconhecidas,
  variaveisVazias,
  modeloCitaLinkMessenger,
  VARIAVEIS_OPCIONAIS,
  maisAntigaEmAberto,
  faturaParaPedido
} from '../src/utils/wa/waCobranca.js';

const HOJE = new Date('2026-09-08T12:00:00Z');

const vencida = { amount: 129.9, dueDate: '2026-08-27', pix: 'PIX1', digitableLine: '0001', link: 'https://b/1', paid: false };
const aVencer = { amount: 89.9, dueDate: '2026-09-15', pix: 'PIX2', digitableLine: '0002', link: 'https://b/2', paid: false };
const paga = { amount: 50, dueDate: '2026-07-01', paid: true };

describe('formatting', () => {
  test('money is Brazilian, without Intl', () => {
    assert.equal(comoReal(129.9), 'R$ 129,90');
    assert.equal(comoReal(1234.5), 'R$ 1.234,50');
    assert.equal(comoReal(1234567.89), 'R$ 1.234.567,89');
    assert.equal(comoReal(0), 'R$ 0,00');
    assert.equal(comoReal('nao-numero'), '');
  });

  test('dates are dd/mm/yyyy and read in UTC', () => {
    assert.equal(comoDataBr('2026-08-27'), '27/08/2026');
    assert.equal(comoDataBr(new Date('2026-01-05T00:00:00Z')), '05/01/2026');
    assert.equal(comoDataBr(null), '');
    assert.equal(comoDataBr('nao-data'), '');
  });

  test('day counting ignores the clock, so a due date is a calendar day', () => {
    // Both instants are the same calendar day; a timezone-naive subtraction
    // would call this a day of arrears.
    assert.equal(diasEntre('2026-09-08T23:00:00Z', '2026-09-08T01:00:00Z'), 0);
    assert.equal(diasEntre('2026-08-27', HOJE), 12);
    assert.equal(diasEntre('2026-09-15', HOJE), -7);
  });
});

describe('the mirror variables', () => {
  test('an overdue invoice fills dias_atraso and empties dias_para_vencer', () => {
    const v = variaveisDeCobranca(vencida, 'João', HOJE);
    assert.equal(v.dias_atraso, '12');
    assert.equal(v.dias_para_vencer, '');
    assert.equal(v.valor, 'R$ 129,90');
    assert.equal(v.vencimento, '27/08/2026');
  });

  test('an invoice not yet due does the opposite', () => {
    const v = variaveisDeCobranca(aVencer, 'Maria', HOJE);
    assert.equal(v.dias_atraso, '');
    assert.equal(v.dias_para_vencer, '7');
  });

  test('an invoice due today counts as not yet due', () => {
    const v = variaveisDeCobranca({ ...aVencer, dueDate: '2026-09-08' }, 'Ana', HOJE);
    assert.equal(v.dias_atraso, '');
    assert.equal(v.dias_para_vencer, '0');
  });
});

describe('the refusal rule', () => {
  test('renders when every cited variable has a value', () => {
    const texto = renderCobranca(
      'Oi {{nome}}, sua fatura de {{valor}} venceu há {{dias_atraso}} dias. PIX: {{pix}}',
      variaveisDeCobranca(vencida, 'João', HOJE)
    );
    assert.equal(texto, 'Oi João, sua fatura de R$ 129,90 venceu há 12 dias. PIX: PIX1');
  });

  test('refuses the whole message when one variable is empty', () => {
    // The invoice carries no PIX code. Sending "PIX: " tells a debtor to pay
    // nothing; leaving "{{pix}}" literal tells them to pay a placeholder.
    const semPix = { ...vencida, pix: '' };
    assert.equal(
      renderCobranca('Pague por PIX: {{pix}}', variaveisDeCobranca(semPix, 'João', HOJE)),
      null
    );
  });

  test('a dunning text cannot reach someone who is not yet due', () => {
    // This is the rule doing its work: `dias_atraso` is empty for a future
    // invoice, so the whole message is refused. No screen warning, no operator
    // discipline — the render refuses.
    assert.equal(
      renderCobranca('Está em atraso há {{dias_atraso}} dias', variaveisDeCobranca(aVencer, 'Maria', HOJE)),
      null
    );
  });

  test('a reminder cannot reach someone already overdue', () => {
    assert.equal(
      renderCobranca('Vence em {{dias_para_vencer}} dias', variaveisDeCobranca(vencida, 'João', HOJE)),
      null
    );
  });

  test('a template with no variables always renders', () => {
    assert.equal(renderCobranca('Passe na loja', {}), 'Passe na loja');
  });
});

describe('a variável opcional link_messenger', () => {
  const MODELO = 'Olá {{nome}}, sua fatura de {{valor}} venceu.\nPrefere o Messenger? {{link_messenger}}\nSe já pagou, desconsidere.';
  const base = () => variaveisDeCobranca(vencida, 'João', HOJE);

  test('com o link, entra no texto como qualquer variável', () => {
    const texto = renderCobranca(MODELO, { ...base(), link_messenger: 'https://m.me/1000000001?ref=abc' });
    assert.equal(texto, 'Olá João, sua fatura de R$ 129,90 venceu.\nPrefere o Messenger? https://m.me/1000000001?ref=abc\nSe já pagou, desconsidere.');
  });

  test('sem o link NÃO recusa a cobrança: a linha que o cita sai inteira', () => {
    const texto = renderCobranca(MODELO, base());
    assert.equal(texto, 'Olá João, sua fatura de R$ 129,90 venceu.\nSe já pagou, desconsidere.');
    assert.ok(!texto.includes('Messenger'));
  });

  test('a linha que sai não deixa buraco de linhas em branco', () => {
    const modelo = 'Olá {{nome}}.\n\nMessenger: {{link_messenger}}\n\nObrigado.';
    assert.equal(renderCobranca(modelo, base()), 'Olá João.\n\nObrigado.');
  });

  test('a regra 1 continua valendo para todo o resto', () => {
    // Um PIX vazio ainda recusa, mesmo com o link opcional presente.
    const semPix = variaveisDeCobranca({ ...vencida, pix: '' }, 'João', HOJE);
    assert.equal(renderCobranca('PIX: {{pix}}\nMessenger: {{link_messenger}}', { ...semPix, link_messenger: 'https://m.me/1?ref=x' }), null);
    assert.equal(renderCobranca('PIX: {{pix}}\nMessenger: {{link_messenger}}', semPix), null);
  });

  test('um modelo que é só a variável opcional vazia não vira mensagem vazia', () => {
    assert.equal(renderCobranca('{{link_messenger}}', base()), null);
    assert.equal(renderCobranca('  {{link_messenger}}  ', base()), null);
  });

  test('a variável opcional vazia não aparece como motivo de recusa', () => {
    assert.deepEqual(variaveisVazias('PIX: {{pix}} {{link_messenger}}', { pix: '', link_messenger: '' }), ['pix']);
    assert.deepEqual(variaveisVazias('{{link_messenger}}', {}), []);
  });

  test('é uma variável conhecida, opcional, e o modelo diz se pede o link', () => {
    assert.ok(VARIAVEIS_DE_COBRANCA.includes('link_messenger'));
    assert.deepEqual([...VARIAVEIS_OPCIONAIS], ['link_messenger']);
    assert.deepEqual(variaveisDesconhecidas(MODELO), []);
    assert.equal(modeloCitaLinkMessenger(MODELO), true);
    assert.equal(modeloCitaLinkMessenger('{{ link_messenger }}'), true);
    assert.equal(modeloCitaLinkMessenger('Olá {{nome}}'), false);
    assert.equal(modeloCitaLinkMessenger(null), false);
  });

  test('o resto dos modelos renderiza igual a antes', () => {
    assert.equal(renderCobranca('Olá {{nome}}', base()), 'Olá João');
    assert.equal(renderCobranca('Linha 1\n\n\n\nLinha 2', {}), 'Linha 1\n\n\n\nLinha 2', 'sem opcional, o texto não é mexido');
  });
});

describe('template classification', () => {
  test('a template citing dias_para_vencer declares itself a reminder', () => {
    assert.equal(modeloEhLembrete('Vence em {{dias_para_vencer}} dias'), true);
    assert.equal(modeloEhLembrete('Vence em {{ dias_para_vencer }} dias'), true);
    assert.equal(modeloEhLembrete('Atraso de {{dias_atraso}} dias'), false);
    assert.equal(modeloEhLembrete(''), false);
  });

  test('reports variables the dispatcher cannot fill', () => {
    assert.deepEqual(variaveisDesconhecidas('Oi {{nome}}, {{cidade}} e {{pedido}}'), ['cidade', 'pedido']);
    assert.deepEqual(variaveisDesconhecidas('Oi {{nome}}, {{valor}}'), []);
  });

  test('every documented variable is fillable', () => {
    const v = variaveisDeCobranca(vencida, 'João', HOJE);
    for (const nome of VARIAVEIS_DE_COBRANCA) {
      assert.ok(nome in v, nome);
    }
  });
});

describe('choosing the invoice to cite', () => {
  test('the oldest overdue one wins', () => {
    const maisVelha = { ...vencida, dueDate: '2026-07-10', pix: 'ANTIGA' };
    const { fatura, soFuturas } = maisAntigaEmAberto([vencida, maisVelha, aVencer], HOJE);
    assert.equal(fatura.pix, 'ANTIGA');
    assert.equal(soFuturas, false);
  });

  test('paid invoices are never cited', () => {
    assert.equal(maisAntigaEmAberto([paga], HOJE).fatura, null);
  });

  test('with only future invoices, a dunning template gets nothing and says why', () => {
    const { fatura, soFuturas } = maisAntigaEmAberto([aVencer], HOJE, false);
    assert.equal(fatura, null);
    // The caller needs the reason so the skip count can say "only has invoices
    // not yet due" rather than lumping it with "no open invoice".
    assert.equal(soFuturas, true);
  });

  test('with only future invoices, a reminder gets the next one', () => {
    const { fatura, soFuturas } = maisAntigaEmAberto([aVencer], HOJE, true);
    assert.equal(fatura.pix, 'PIX2');
    assert.equal(soFuturas, false);
  });

  test('an empty wallet is not "only future"', () => {
    assert.deepEqual(maisAntigaEmAberto([], HOJE), { fatura: null, soFuturas: false });
  });
});

describe('separarCodigos', () => {
  const vars = { nome: 'Ana', pix: 'PIX-123', linha_digitavel: 'LINHA-456', link_boleto: 'https://x/b' };
  const marcas = { pix: '(a seguir)', linha_digitavel: '(a seguir)' };

  test('tira do texto só o que o modelo cita, PIX antes da linha', () => {
    const r = separarCodigos('Oi {{nome}}. Linha: {{linha_digitavel}} PIX: {{pix}}', vars, marcas);
    assert.deepEqual(r.extras, ['PIX-123', 'LINHA-456']);
    assert.equal(renderCobranca('Oi {{nome}}. Linha: {{linha_digitavel}} PIX: {{pix}}', r.vars), 'Oi Ana. Linha: (a seguir) PIX: (a seguir)');
  });

  test('o modelo que cita só o PIX manda só o PIX; a linha fica como está', () => {
    const r = separarCodigos('PIX: {{pix}} e {{link_boleto}}', vars, marcas);
    assert.deepEqual(r.extras, ['PIX-123']);
    assert.equal(r.vars.link_boleto, 'https://x/b');
    assert.equal(r.vars.linha_digitavel, 'LINHA-456');
  });

  test('sem citação de código devolve null, e o modelo sai como está', () => {
    assert.equal(separarCodigos('Oi {{nome}}, boleto {{link_boleto}}', vars, marcas), null);
  });
});

describe('faturaParaPedido', () => {
  const hoje = new Date('2026-12-01T15:00:00Z');
  const aberta = (dueDate) => ({ id: dueDate, dueDate, paid: false });
  const escolha = (faturas, dias = 5) => faturaParaPedido(faturas, hoje, dias);

  test('vencida e vencendo hoje saem sempre, a mais antiga primeiro', () => {
    assert.equal(escolha([aberta('2026-11-30'), aberta('2026-11-20')], 0).fatura.dueDate, '2026-11-20');
    assert.equal(escolha([aberta('2026-12-01')], 0).fatura.dueDate, '2026-12-01');
  });

  test('a vencer sai dentro do prazo e não passa dele', () => {
    assert.equal(escolha([aberta('2026-12-06')]).fatura.dueDate, '2026-12-06');
    const fora = escolha([aberta('2026-12-07')]);
    assert.equal(fora.fatura, null);
    assert.equal(fora.proxima.dueDate, '2026-12-07');
    assert.equal(fora.liberaEm, '2026-12-02', 'vence dia 7, prazo 5: libera no dia 2');
  });

  test('prazo 0 segura a de amanhã; prazo maior libera', () => {
    assert.equal(escolha([aberta('2026-12-02')], 0).fatura, null);
    assert.equal(escolha([aberta('2026-12-10')], 15).fatura.dueDate, '2026-12-10');
  });

  test('entre duas a vencer, a mais próxima; paga e sem data ficam de fora', () => {
    const r = escolha([aberta('2026-12-20'), aberta('2026-12-12'), { ...aberta('2026-12-02'), paid: true }, { id: 'x' }]);
    assert.equal(r.proxima.dueDate, '2026-12-12');
  });

  test('nada em aberto não quebra', () => {
    assert.deepEqual(escolha([]), { fatura: null, proxima: null, liberaEm: null });
    assert.deepEqual(escolha(undefined), { fatura: null, proxima: null, liberaEm: null });
  });

  test('uma vencida ganha de uma a vencer dentro do prazo', () => {
    assert.equal(escolha([aberta('2026-12-03'), aberta('2026-11-25')]).fatura.dueDate, '2026-11-25');
  });
});
