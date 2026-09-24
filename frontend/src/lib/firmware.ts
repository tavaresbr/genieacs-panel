/**
 * Firmware da ONT: o que a tela decide sozinha.
 *
 * Quem decide o que SERVE para a ONT é o servidor (`backend/src/services/firmwareFiles.js`),
 * que confere de novo na hora de mandar. Aqui é só a escolha inicial e a forma
 * de mostrar o tamanho — funções puras, porque o vitest roda em `node`, sem jsdom.
 */
import type { DeviceFirmwareFile } from '@/lib/api'

/**
 * O arquivo que a tela já deixa marcado: o mais novo que não é o instalado.
 *
 * A lista chega do servidor do mais novo para o mais antigo. Nenhum marcado
 * quando só sobra o instalado — reinstalar a mesma versão é recusado.
 */
export function defaultFirmwareChoice(files: readonly DeviceFirmwareFile[]): string | null {
  return files.find((file) => !file.installed)?.id ?? null
}

/** O tamanho em unidades de 1024, com uma casa: firmware tem dezenas de MB. */
export function formatFileSize(bytes: number | null | undefined): string | null {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  const unidades = ['KB', 'MB', 'GB']
  let valor = bytes / 1024
  let indice = 0
  while (valor >= 1024 && indice < unidades.length - 1) {
    valor /= 1024
    indice += 1
  }
  return `${valor.toFixed(1)} ${unidades[indice]}`
}
