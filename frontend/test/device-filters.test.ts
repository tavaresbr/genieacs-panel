import { describe, expect, it } from 'vitest'

import {
  filtersFromQuery,
  filtersToQuery,
  NO_FILTERS,
  pageFromQuery,
  sgpFromQuery,
  statusFromQuery,
  type DeviceFilters,
} from '@/lib/device-filters'

/**
 * O recorte que viaja na URL.
 *
 * O que estes casos defendem é a diferença entre um link útil e um link que
 * mente. O painel manda "os 7 que precisam de atenção" para cá, e se o
 * parâmetro se perder no caminho a tela abre o inventário inteiro sob aquele
 * rótulo — que é exatamente o que os links faziam antes destes parâmetros
 * existirem, e o que ninguém percebia.
 */

const q = (texto: string) => new URLSearchParams(texto)

describe('a query lida', () => {
  it('traz o recorte que o painel escolheu', () => {
    expect(filtersFromQuery(q('status=offline'))).toEqual({ ...NO_FILTERS, status: 'offline' })
    expect(filtersFromQuery(q('status=online'))).toEqual({ ...NO_FILTERS, status: 'online' })
  })

  it('e o recorte inteiro, quando há mais de um', () => {
    expect(filtersFromQuery(q('search=ONT-9&status=offline&sgp=blocked&page=3'))).toEqual({
      search: 'ONT-9', status: 'offline', sgp: 'blocked', page: 3
    })
  })

  it('uma query vazia é a lista inteira', () => {
    expect(filtersFromQuery(q(''))).toEqual(NO_FILTERS)
  })
})

describe('o que vem de fora nunca chega à API', () => {
  it('valor inventado vira "todos", e não um cast', () => {
    // Uma query é digitável, colável e editável por quem passar. `banana` tem
    // que morrer aqui; mandado adiante, ele vira um parâmetro que o servidor
    // não conhece.
    expect(statusFromQuery('banana')).toBe('all')
    expect(sgpFromQuery('banana')).toBe('all')
    expect(filtersFromQuery(q('status=banana&sgp=banana'))).toEqual(NO_FILTERS)
  })

  it('nulo, vazio e ausente também', () => {
    expect(statusFromQuery(null)).toBe('all')
    expect(statusFromQuery('')).toBe('all')
    expect(statusFromQuery(undefined)).toBe('all')
    expect(sgpFromQuery(null)).toBe('all')
  })

  it('a página recusa os três jeitos de um número não ser um número', () => {
    // `Number.parseInt` aceita `'12abc'` e `' 12'`; `Number('')` é zero. Uma
    // query mal colada não pode virar requisição com página inválida.
    expect(pageFromQuery('12abc')).toBe(12)
    expect(pageFromQuery('0')).toBe(1)
    expect(pageFromQuery('-3')).toBe(1)
    expect(pageFromQuery('')).toBe(1)
    expect(pageFromQuery('abc')).toBe(1)
    expect(pageFromQuery(null)).toBe(1)
  })
})

describe('a query escrita', () => {
  it('o default SOME do endereço', () => {
    // `/devices` é a lista inteira. `status=all&sgp=all&page=1` não acrescenta
    // informação nenhuma e só faz o link ficar feio de mandar para alguém.
    expect(filtersToQuery(NO_FILTERS).toString()).toBe('')
  })

  it('e o que não é default aparece', () => {
    expect(filtersToQuery({ ...NO_FILTERS, status: 'offline' }).toString()).toBe('status=offline')
    expect(filtersToQuery({ ...NO_FILTERS, page: 4 }).toString()).toBe('page=4')
  })

  it('a ida e a volta dão o mesmo recorte', () => {
    // A prova que amarra as duas metades: o que a tela escreve na URL é o que
    // a tela lê de volta ao recarregar. Sem isto, um link mandado para o
    // plantão poderia abrir outra coisa.
    const casos: DeviceFilters[] = [
      NO_FILTERS,
      { search: 'ONT-9', status: 'offline', sgp: 'unlinked', page: 2 },
      { search: '', status: 'online', sgp: 'all', page: 1 },
      { search: 'a b&c=d', status: 'all', sgp: 'cancelled', page: 11 }
    ]
    for (const caso of casos) {
      expect(filtersFromQuery(filtersToQuery(caso)), JSON.stringify(caso)).toEqual(caso)
    }
  })

  it('e a busca com caracteres de query sobrevive à viagem', () => {
    // `&` e `=` dentro do texto buscado quebrariam a query se fossem
    // concatenados à mão. `URLSearchParams` escapa, e este caso é o que
    // garante que ninguém a troque por interpolação de string.
    const url = filtersToQuery({ ...NO_FILTERS, search: 'a&status=online' })
    expect(filtersFromQuery(url).search).toBe('a&status=online')
    expect(filtersFromQuery(url).status).toBe('all')
  })
})
