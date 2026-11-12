/**
 * Preparar a foto do operador antes de enviá-la: quadrada, pequena, JPEG.
 *
 * O servidor guarda a imagem dentro do cadastro (teto de 96 KB) e a devolve em
 * toda lista de operadores, então ela é REDUZIDA aqui: recorte central quadrado
 * e 192×192. Reencodar no canvas também descarta metadados (GPS, câmera) da
 * foto original — o que sobe é só a imagem.
 */

export const AVATAR_SIZE = 192
/** O que se aceita ESCOLHER: o arquivo original pode ser grande, ele é reduzido. */
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp'
export const AVATAR_MAX_SOURCE_BYTES = 15 * 1024 * 1024

export type AvatarProblem = 'type' | 'size' | 'decode'

/** O arquivo escolhido serve para virar foto? (O servidor confere os bytes de novo.) */
export function avatarFileProblem(file: { type: string; size: number }): AvatarProblem | null {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return 'type'
  if (file.size > AVATAR_MAX_SOURCE_BYTES) return 'size'
  return null
}

/** O retângulo do recorte central quadrado de uma imagem `width × height`. */
export function centerSquare(width: number, height: number): { sx: number; sy: number; side: number } {
  const side = Math.min(width, height)
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side }
}

/** O arquivo vira um data URL JPEG `AVATAR_SIZE × AVATAR_SIZE`, pronto para o `PUT`. */
export async function fileToAvatarDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file).catch(() => null)
  if (!bitmap) throw new Error('decode')
  try {
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_SIZE
    canvas.height = AVATAR_SIZE
    const context = canvas.getContext('2d')
    if (!context) throw new Error('decode')
    // Fundo branco: um PNG com transparência não vira um quadrado preto no JPEG.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE)
    const { sx, sy, side } = centerSquare(bitmap.width, bitmap.height)
    context.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    bitmap.close()
  }
}

/** As iniciais para quando não há foto: duas letras no máximo. */
export function initialsOf(name: string | null | undefined): string {
  const words = String(name ?? '').trim().split(/[\s._-]+/).filter(Boolean)
  if (!words.length) return '?'
  const first = words[0][0]
  const last = words.length > 1 ? words[words.length - 1][0] : ''
  return (first + last).toUpperCase()
}
