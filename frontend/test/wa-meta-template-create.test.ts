import { describe, expect, it } from 'vitest'

import type { WhatsAppMetaTemplate } from '@/lib/api'
import {
  bodyVariables,
  draftFromTemplate,
  emptyMetaDraft,
  nextVariable,
  normalizeMetaName,
  renderMetaPreview,
  toMetaPayload,
  validateDraft,
  type MetaTemplateDraft
} from '@/components/whatsapp/meta-template-create'

const draft = (patch: Partial<MetaTemplateDraft> = {}): MetaTemplateDraft => ({
  ...emptyMetaDraft(),
  name: 'aviso_fatura',
  bodyText: 'Olá {{1}}, vence {{2}}.',
  examples: ['Ana', '10/10'],
  ...patch
})

/**
 * O formulário de criar modelo na Meta segue as regras do servidor, para o
 * botão só acender quando a revisão não teria motivo de formato para recusar.
 */
describe('o nome do modelo', () => {
  it('vira minúsculas com _ e sem acento', () => {
    expect(normalizeMetaName('Aviso de Cobrança 2')).toBe('aviso_de_cobranca_2')
    expect(normalizeMetaName('promo-relâmpago!')).toBe('promorelampago')
  })
})

describe('as variáveis do corpo', () => {
  it('contam pelo maior número e exigem sequência sem pulo', () => {
    expect(bodyVariables('Oi')).toEqual({ count: 0, ok: true })
    expect(bodyVariables('{{1}} e {{2}} e {{1}}')).toEqual({ count: 2, ok: true })
    expect(bodyVariables('{{1}} e {{3}}')).toEqual({ count: 3, ok: false })
    expect(bodyVariables('Oi {{nome}}').ok).toBe(false)
  })

  it('a próxima é uma depois da maior', () => {
    expect(nextVariable('')).toBe('{{1}}')
    expect(nextVariable('Olá {{1}}, {{2}}')).toBe('{{3}}')
  })
})

describe('validateDraft', () => {
  it('um modelo completo passa', () => {
    expect(validateDraft(draft({
      headerText: 'Sua fatura',
      footerText: 'Provedor',
      buttons: [{ type: 'URL', text: 'Pagar', url: 'https://pague.test/x' }, { type: 'QUICK_REPLY', text: 'Ok', url: '' }]
    }))).toEqual([])
  })

  it('aponta cada campo errado', () => {
    expect(validateDraft(draft({ name: '' }))).toContain('name')
    expect(validateDraft(draft({ language: 'portugues' }))).toContain('language')
    expect(validateDraft(draft({ bodyText: '', examples: [] }))).toContain('bodyText')
    expect(validateDraft(draft({ bodyText: 'x'.repeat(1025), examples: [] }))).toContain('bodyText')
    expect(validateDraft(draft({ bodyText: '{{1}} {{3}}' }))).toContain('variables')
    expect(validateDraft(draft({ examples: ['Ana', '  '] }))).toEqual(['examples'])
    expect(validateDraft(draft({ headerText: 'Oi {{1}}' }))).toEqual(['headerText'])
    expect(validateDraft(draft({ footerText: 'x'.repeat(61) }))).toEqual(['footerText'])
    expect(validateDraft(draft({ buttons: [{ type: 'URL', text: 'Pagar', url: 'http://inseguro.test' }] }))).toEqual(['buttons'])
    const ok = { type: 'QUICK_REPLY' as const, text: 'Ok', url: '' }
    expect(validateDraft(draft({ buttons: [ok, ok, ok, ok] }))).toEqual(['buttons'])
    expect(validateDraft(draft({ buttons: [{ ...ok, text: 'x'.repeat(26) }] }))).toEqual(['buttons'])
  })
})

describe('o pedido e a prévia', () => {
  it('o pedido corta exemplos que sobraram e omite cabeçalho e rodapé vazios', () => {
    const payload = toMetaPayload(draft({ bodyText: 'Olá {{1}}', examples: ['Ana', 'sobrou'], headerText: '  ' }))
    expect(payload.examples).toEqual(['Ana'])
    expect(payload).not.toHaveProperty('headerText')
    expect(payload).not.toHaveProperty('footerText')
    expect(payload.buttons).toEqual([])
  })

  it('a resposta rápida vai sem URL', () => {
    const payload = toMetaPayload(draft({ buttons: [{ type: 'QUICK_REPLY', text: ' Ok ', url: 'https://x' }] }))
    expect(payload.buttons).toEqual([{ type: 'QUICK_REPLY', text: 'Ok' }])
  })

  it('a prévia troca cada variável pelo exemplo, e deixa a que não tem', () => {
    expect(renderMetaPreview('Olá {{1}}, vence {{2}}.', ['Ana'])).toBe('Olá Ana, vence {{2}}.')
  })
})

/** A edição parte do modelo como está na Meta, com nome e idioma travados. */
describe('rascunho de edição', () => {
  const modelo = (patch: Partial<WhatsAppMetaTemplate> = {}): WhatsAppMetaTemplate => ({
    id: 7, accountId: 1, name: 'aviso_geral', language: 'pt_BR', category: 'MARKETING', status: 'APPROVED',
    bodyText: 'Olá {{1}}', paramCount: 1, paramFormat: 'positional', headerFormat: 'TEXT', headerParamCount: 0,
    buttons: [], supported: true, usable: true, syncedAt: null, hasMetaId: true, editable: true,
    rejectedReason: null, qualityScore: null, previousStatus: null, statusChangedAt: null,
    draft: { headerText: 'Aviso', bodyText: 'Olá {{1}}', examples: ['Ana'], footerText: '', buttons: [{ type: 'QUICK_REPLY', text: 'Ok', url: '' }] },
    ...patch
  })

  it('preenche o formulário com o que o modelo tem, e passa na validação', () => {
    const d = draftFromTemplate(modelo())
    expect(d).toMatchObject({ name: 'aviso_geral', language: 'pt_BR', category: 'MARKETING', headerText: 'Aviso', examples: ['Ana'] })
    expect(validateDraft(d!)).toEqual([])
  })

  it('não abre o formulário para o que não é editável pelo painel', () => {
    expect(draftFromTemplate(modelo({ editable: false }))).toBeNull()
    expect(draftFromTemplate(modelo({ draft: null }))).toBeNull()
  })
})
