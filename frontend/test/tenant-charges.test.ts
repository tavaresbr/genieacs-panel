import { describe, expect, it } from 'vitest'

import type { TenantChargeView } from '@/lib/api'
import en from '@/lib/i18n/locales/en'
import {
  CHARGE_STATUS_FILTER_KEYS, CHARGE_STATUS_FILTERS, PAYMENT_METHOD_KEYS, chargeKindKey, chargeYearOptions, csvCell,
  paymentMethodKey, tenantChargesCsv
} from '@/lib/tenant-charges'

/** As faturas do provedor: rótulos, anos do seletor e a planilha neutralizada. */

function cobranca(patch: Partial<TenantChargeView> = {}): TenantChargeView {
  return {
    id: 1,
    periodEnd: '2026-03-31',
    amountCents: 19900,
    currency: 'BRL',
    status: 'paid',
    dueDate: '2026-03-25',
    invoiceUrl: null,
    createdAt: '2026-03-01T12:00:00.000Z',
    kind: 'renewal',
    creditCents: 0,
    paidAt: '2026-03-20',
    paymentMethod: 'PIX',
    earlyDiscountCents: 995,
    couponCode: null,
    ...patch
  }
}

const labels = {
  status: (s: string) => `S:${s}`,
  kind: (k: string | null | undefined) => `K:${k ?? 'renewal'}`,
  method: (m: string | null | undefined) => `M:${m ?? '-'}`
}

describe('csvCell', () => {
  it('neutraliza o que o Excel leria como fórmula, também depois de espaço', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+1+1')).toBe("'+1+1")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('  =1+1')).toBe("'  =1+1")
    expect(csvCell('\n=1')).toBe(`"'\n=1"`)
    expect(csvCell('\tcoisa')).toBe("'\tcoisa")
  })

  it('deixa número negativo e texto comum como estão', () => {
    expect(csvCell('-12.50')).toBe('-12.50')
    expect(csvCell('Provedor Alfa')).toBe('Provedor Alfa')
    expect(csvCell(null)).toBe('')
    expect(csvCell('a;b')).toBe('"a;b"')
  })
})

describe('tenantChargesCsv', () => {
  it('escreve cabeçalho, valores em reais e datas ISO, com BOM e ponto e vírgula', () => {
    const csv = tenantChargesCsv([cobranca(), cobranca({ id: 2, status: 'pending', paidAt: null, paymentMethod: null, earlyDiscountCents: 0, kind: 'proration' })], ['id', 'tipo'], labels)
    expect(csv.startsWith('\uFEFF')).toBe(true)
    const linhas = csv.slice(1).trimEnd().split('\r\n')
    expect(linhas[0]).toBe('id;tipo')
    expect(linhas[1]).toBe('1;K:renewal;2026-03-31;2026-03-25;S:paid;BRL;199.00;9.95;0.00;;2026-03-20;M:PIX;')
    // Sem pagamento, sem meio: a coluna fica vazia, e não "não informado".
    expect(linhas[2]).toBe('2;K:proration;2026-03-31;2026-03-25;S:pending;BRL;199.00;0.00;0.00;;;;')
  })

  it('neutraliza o cupom e o número da nota que começam com sinal', () => {
    const csv = tenantChargesCsv([
      cobranca({ couponCode: '=CMD()', invoice: { status: 'authorized', number: '@123', pdfUrl: null } as TenantChargeView['invoice'] })
    ], ['id'], labels)
    const linha = csv.slice(1).trimEnd().split('\r\n')[1]
    expect(linha).toContain(";'=CMD();")
    expect(linha.endsWith(";'@123")).toBe(true)
  })
})

describe('rótulos', () => {
  it('cada filtro, tipo e meio tem texto no dicionário', () => {
    for (const filtro of CHARGE_STATUS_FILTERS) expect(en[CHARGE_STATUS_FILTER_KEYS[filtro]]).toBeTruthy()
    for (const kind of ['renewal', 'proration', 'overage', undefined, 'novo']) expect(en[chargeKindKey(kind)]).toBeTruthy()
    for (const key of Object.values(PAYMENT_METHOD_KEYS)) expect(en[key]).toBeTruthy()
  })

  it('o meio desconhecido ou ausente vira "não informado"', () => {
    expect(paymentMethodKey('pix')).toBe('charges.method.pix')
    expect(paymentMethodKey('CREDIT_CARD')).toBe('charges.method.creditCard')
    expect(paymentMethodKey('CHEQUE')).toBe('charges.method.unknown')
    expect(paymentMethodKey(null)).toBe('charges.method.unknown')
  })
})

describe('chargeYearOptions', () => {
  it('junta o ano atual aos do servidor, sem repetir, do mais recente ao mais antigo', () => {
    const agora = new Date(2026, 5, 1)
    expect(chargeYearOptions([2024, 2026, 2025], agora)).toEqual([2026, 2025, 2024])
    expect(chargeYearOptions(undefined, agora)).toEqual([2026])
    expect(chargeYearOptions([2027], agora)).toEqual([2027, 2026])
  })
})
