/**
 * Prepara a logo e o favicon antes do envio: o servidor só aceita PNG, JPG,
 * WebP ou ICO dentro de um teto de bytes (`platformBrandingService.js`), então
 * o painel reduz e converte o que passa dele em vez de devolver o erro.
 *
 * A imagem é desenhada num canvas e regravada como PNG (ou WebP, para a logo
 * que ainda ficar grande), o que também torna seguro aceitar um SVG: ele sai
 * daqui como raster, nunca como SVG.
 */
export type BrandingKind = 'logo' | 'favicon'

/** Os mesmos tetos do servidor, mais o maior lado que vale a pena guardar. */
export const BRANDING_LIMITS: Record<BrandingKind, { bytes: number; maxSide: number }> = {
  logo: { bytes: 512 * 1024, maxSide: 512 },
  favicon: { bytes: 128 * 1024, maxSide: 128 }
}

const SERVER_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/x-icon', 'image/vnd.microsoft.icon']
/** O favicon não desce abaixo disto ao tentar caber no teto. */
const MIN_SIDE = 32

export class BrandingImageError extends Error {
  code: 'decode' | 'too_large'
  constructor(code: 'decode' | 'too_large') {
    super(code)
    this.name = 'BrandingImageError'
    this.code = code
  }
}

/** Reduz para caber em `maxSide`, mantendo a proporção; nunca amplia. */
export function fitSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  const maior = Math.max(width, height)
  if (!(maior > 0)) return { width: maxSide, height: maxSide }
  const escala = Math.min(1, maxSide / maior)
  return { width: Math.max(1, Math.round(width * escala)), height: Math.max(1, Math.round(height * escala)) }
}

/** Se o arquivo já serve como está: tipo que o servidor aceita e dentro do teto. */
export function isServerReady(type: string, size: number, kind: BrandingKind): boolean {
  return SERVER_TYPES.includes(type) && size > 0 && size <= BRANDING_LIMITS[kind].bytes
}

function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new BrandingImageError('decode')) }
    img.src = url
  })
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

function renameTo(name: string, type: string): string {
  const base = name.replace(/\.[^.]+$/, '') || 'image'
  return `${base}.${type === 'image/webp' ? 'webp' : 'png'}`
}

/**
 * Devolve um arquivo que o servidor aceita. O que já serve passa intacto; o
 * resto é redimensionado e convertido. Lança `BrandingImageError`: `decode`
 * quando o navegador não abre o arquivo, `too_large` quando nem reduzido cabe.
 */
export async function prepareBrandingImage(file: File, kind: BrandingKind): Promise<File> {
  if (isServerReady(file.type, file.size, kind)) return file
  // Um ICO fora do teto não dá para reencodar aqui: o navegador não o decodifica
  // de forma confiável, e o servidor o recusaria de qualquer jeito.
  if (file.type === 'image/x-icon' || file.type === 'image/vnd.microsoft.icon') throw new BrandingImageError('too_large')

  const img = await loadImage(file)
  // SVG sem tamanho próprio chega como 0×0.
  const largura = img.naturalWidth || BRANDING_LIMITS[kind].maxSide
  const altura = img.naturalHeight || BRANDING_LIMITS[kind].maxSide
  const { bytes, maxSide } = BRANDING_LIMITS[kind]

  for (let lado = maxSide; lado >= MIN_SIDE; lado = Math.floor(lado * 0.75)) {
    const alvo = fitSize(largura, altura, lado)
    // O favicon é quadrado: a imagem entra inteira, centralizada, com fundo transparente.
    const canvas = document.createElement('canvas')
    canvas.width = kind === 'favicon' ? lado : alvo.width
    canvas.height = kind === 'favicon' ? lado : alvo.height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new BrandingImageError('decode')
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, (canvas.width - alvo.width) / 2, (canvas.height - alvo.height) / 2, alvo.width, alvo.height)

    const tentativas: Array<[string, number | undefined]> = kind === 'logo'
      ? [['image/png', undefined], ['image/webp', 0.85], ['image/webp', 0.6]]
      : [['image/png', undefined]]
    for (const [tipo, qualidade] of tentativas) {
      const blob = await toBlob(canvas, tipo, qualidade)
      // Um navegador sem WebP devolve PNG: o tipo real é o que o blob diz.
      if (blob && blob.size > 0 && blob.size <= bytes && SERVER_TYPES.includes(blob.type)) {
        return new File([blob], renameTo(file.name, blob.type), { type: blob.type })
      }
    }
  }
  throw new BrandingImageError('too_large')
}
