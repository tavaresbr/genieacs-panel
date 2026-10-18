import { useSyncExternalStore } from 'react'
import { publicTenantAPI, type PublicBrand } from '@/lib/api'

/**
 * A logo e o favicon que o console da plataforma enviou (Configurações → Dados
 * do SaaS). Um estoque de módulo, e não um contexto: a marca aparece em telas
 * que nascem fora de qualquer provider (o portal do cliente, o login), e todas
 * leem a mesma resposta.
 */
const VAZIO: PublicBrand = { logoUrl: null, faviconUrl: null }

let atual: PublicBrand = VAZIO
let pedido: Promise<void> | null = null
const ouvintes = new Set<() => void>()

/** O ícone original, que volta quando o console remove o favicon enviado. */
let faviconOriginal: { href: string; type: string | null } | null = null

function aplicarFavicon(url: string | null) {
  if (typeof document === 'undefined') return
  const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]')
  if (!link) return
  if (!faviconOriginal) faviconOriginal = { href: link.getAttribute('href') ?? '', type: link.getAttribute('type') }
  if (url) {
    // O tipo do arquivo enviado não é o do SVG original; sem o atributo o
    // navegador descobre sozinho.
    link.removeAttribute('type')
    link.setAttribute('href', url)
  } else {
    if (faviconOriginal.type) link.setAttribute('type', faviconOriginal.type)
    link.setAttribute('href', faviconOriginal.href)
  }
}

function definir(brand: PublicBrand) {
  atual = brand
  aplicarFavicon(brand.faviconUrl)
  ouvintes.forEach((fn) => fn())
}

/** Lê a marca uma vez por carregamento da página. */
export function loadBrand(): Promise<void> {
  pedido ??= publicTenantAPI.brand().then((res) => {
    if (res.success && res.data) definir(res.data)
  }, () => undefined)
  return pedido
}

/** Lê de novo, depois de o console trocar ou remover uma imagem. */
export function refreshBrand(): Promise<void> {
  pedido = null
  return loadBrand()
}

export function useBrand(): PublicBrand {
  return useSyncExternalStore(
    (fn) => {
      ouvintes.add(fn)
      void loadBrand()
      return () => ouvintes.delete(fn)
    },
    () => atual,
    () => VAZIO
  )
}
