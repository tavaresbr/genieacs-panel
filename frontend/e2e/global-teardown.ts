import fs from 'node:fs'
import path from 'node:path'
import { AUTH_DIR } from './support/demo'

/**
 * Desfaz o `global-setup`: derruba o backend e o Asaas de mentira e apaga o
 * `DATA_DIR` temporário. As capturas e o relatório ficam.
 *
 * O pid e o diretório também estão em `e2e/.auth/run.json`, para o caso de o
 * processo do setup não ser este (não deveria, mas uma limpeza que depende
 * disso deixaria lixo em `/tmp` a cada execução quebrada).
 */
export default async function globalTeardown() {
  const estado = globalThis.__e2e
  let gravado: { pid?: number, dataDir?: string } = {}
  try {
    gravado = JSON.parse(fs.readFileSync(path.join(AUTH_DIR, 'run.json'), 'utf8'))
  } catch {
    // nada gravado: o setup caiu antes
  }

  const backend = estado?.backend
  if (backend && backend.exitCode === null) {
    const saiu = new Promise((resolve) => backend.once('exit', resolve))
    backend.kill('SIGTERM')
    const prazo = setTimeout(() => backend.kill('SIGKILL'), 10_000)
    await saiu
    clearTimeout(prazo)
  } else if (!backend && gravado.pid) {
    try { process.kill(gravado.pid, 'SIGTERM') } catch { /* já saiu */ }
  }

  await estado?.asaas.close().catch(() => {})

  const dataDir = estado?.dataDir ?? gravado.dataDir
  if (dataDir && path.basename(dataDir).startsWith('skygenpanel-e2e-')) {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  globalThis.__e2e = undefined
}
