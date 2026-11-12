import { describe, expect, it } from 'vitest'
import type { Operator } from '@/lib/api'
import {
  emptyProfileForm, filterOperators, isValidCpf, isValidPhone, maskCpf, maskPhone, profileFormFrom, profilePayload, profileProblem
} from '@/lib/operator-profile'

describe('máscaras', () => {
  it('formata o CPF enquanto se digita', () => {
    expect(maskCpf('5299')).toBe('529.9')
    expect(maskCpf('52998224725')).toBe('529.982.247-25')
    expect(maskCpf('529.982.247-25999')).toBe('529.982.247-25')
  })

  it('formata telefone com e sem o 55', () => {
    expect(maskPhone('11912345678')).toBe('(11) 91234-5678')
    expect(maskPhone('1123456789')).toBe('(11) 2345-6789')
    expect(maskPhone('5511912345678')).toBe('+55 (11) 91234-5678')
    expect(maskPhone('')).toBe('')
  })
})

describe('validação', () => {
  it('confere os dígitos verificadores do CPF', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true)
    expect(isValidCpf('111.444.777-35')).toBe(true)
    expect(isValidCpf('111.111.111-11')).toBe(false)
    expect(isValidCpf('123.456.789-00')).toBe(false)
    expect(isValidCpf('123')).toBe(false)
  })

  it('aceita de 10 a 13 dígitos de telefone', () => {
    expect(isValidPhone('(11) 91234-5678')).toBe(true)
    expect(isValidPhone('123')).toBe(false)
  })

  it('aponta o primeiro campo inválido', () => {
    const form = { ...emptyProfileForm(), cpf: '111.111.111-11' }
    expect(profileProblem(form)?.key).toBe('cpf')
    expect(profileProblem({ ...emptyProfileForm(), zip: '123' })?.key).toBe('zip')
    expect(profileProblem(emptyProfileForm())).toBeNull()
  })
})

describe('corpo do PATCH', () => {
  const loaded = profileFormFrom({ fullName: 'Ana', cpf: '52998224725', phone: '11912345678', city: 'Belém' })

  it('mostra o carregado com máscara', () => {
    expect(loaded.cpf).toBe('529.982.247-25')
    expect(loaded.phone).toBe('(11) 91234-5678')
  })

  it('não manda nada quando nada mudou', () => {
    expect(profilePayload({ ...loaded }, loaded)).toEqual({})
  })

  it('manda só o que mudou, com dígitos, e vazio vira null', () => {
    const form = { ...loaded, phone: '(11) 98888-7777', city: '', rg: ' 12.345 ' }
    expect(profilePayload(form, loaded)).toEqual({ phone: '11988887777', city: null, rg: '12.345' })
  })

  it('apaga o CPF com null', () => {
    expect(profilePayload({ ...loaded, cpf: '' }, loaded)).toEqual({ cpf: null })
  })
})

describe('busca de operadores', () => {
  const op = (id: number, username: string, email: string | null, fullName: string | null, jobTitle: string | null) => ({
    id, username, email, role: 'viewer',
    profile: { fullName, jobTitle, phone: null, cpfMasked: null, profileComplete: false }
  }) as unknown as Operator
  const list = [
    op(1, 'ana.silva', 'ana@alfa.test', 'Ana Souza da Silva', 'Técnica de campo'),
    op(2, 'joao', 'joao@alfa.test', 'João Pereira', 'Financeiro'),
    op(3, 'semperfil', null, null, null)
  ]

  it('devolve a lista inteira com busca vazia', () => {
    expect(filterOperators(list, '')).toBe(list)
    expect(filterOperators(list, '   ')).toBe(list)
  })

  it('acha por usuário, e-mail, nome e cargo, sem acento nem caixa', () => {
    expect(filterOperators(list, 'JOAO').map((o) => o.id)).toEqual([2])
    expect(filterOperators(list, 'joão pereira').map((o) => o.id)).toEqual([2])
    expect(filterOperators(list, 'tecnica').map((o) => o.id)).toEqual([1])
    expect(filterOperators(list, 'alfa.test').map((o) => o.id)).toEqual([1, 2])
    expect(filterOperators(list, 'semperfil').map((o) => o.id)).toEqual([3])
  })

  it('exige todas as palavras, em qualquer ordem', () => {
    expect(filterOperators(list, 'silva ana').map((o) => o.id)).toEqual([1])
    expect(filterOperators(list, 'ana financeiro')).toEqual([])
  })
})
