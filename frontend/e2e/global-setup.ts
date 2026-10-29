import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { chromium, type FullConfig } from '@playwright/test'
// @ts-expect-error -- módulo JS puro, sem tipos; é o mesmo que o backend carrega.
import { startFakeAsaas } from './support/fake-asaas.mjs'
import {
  ADMIN, ADMIN_STATE, AUTH_DIR, BACKEND_DIR, E2E_DIR, FRONTEND_DIR, PROVIDER, PROVIDER_STATE, SCREENSHOTS_DIR,
  launchOptions, loginViaForm
} from './support/demo'

/**
 * Monta o ambiente inteiro antes do primeiro cenário:
 *
 * 1. o build do frontend, quando o `dist` falta ou é mais velho que o código
 *    (`E2E_SKIP_BUILD=1` pula, para quem acabou de buildar);
 * 2. o Asaas de mentira (`support/fake-asaas.mjs`), neste processo;
 * 3. o backend na edição SaaS, num `DATA_DIR` temporário (SQLite), numa porta
 *    livre, servindo o `dist` — com `support/allow-fake-asaas.mjs`
 *    pré-carregado;
 * 4. `POST /api/auth/setup`, que cria quem opera a plataforma;
 * 5. `backend/scripts/seed-demo.js`, com o mesmo ambiente do backend;
 * 6. o login das duas contas pela tela, guardado em `e2e/.auth/` para os
 *    cenários que começam já dentro.
 *
 * Cada variável que o backend lê vai explícita, inclusive vazia: o `dotenv`
 * não sobrescreve o que já está posto, e um `backend/.env` de desenvolvimento
 * com `DATABASE_URL` ou `TENANT_BASE_DOMAIN` mudaria o ambiente do teste.
 */

declare global {
  // eslint-disable-next-line no-var
  var __e2e: { backend: ChildProcess, asaas: { close: () => Promise<void> }, dataDir: string } | undefined
}

const SECRET = () => crypto.randomBytes(32).toString('hex')

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
  })
}

/** O instante mais novo de um arquivo dentro de `alvos` (recursivo). */
function newestMtime(alvos: string[]): number {
  let maior = 0
  const visitar = (alvo: string) => {
    if (!fs.existsSync(alvo)) return
    const info = fs.statSync(alvo)
    if (info.isDirectory()) {
      for (const nome of fs.readdirSync(alvo)) visitar(path.join(alvo, nome))
    } else if (info.mtimeMs > maior) {
      maior = info.mtimeMs
    }
  }
  alvos.forEach(visitar)
  return maior
}

function buildIfStale() {
  if (process.env.E2E_SKIP_BUILD === '1') return
  const dist = path.join(FRONTEND_DIR, 'dist', 'index.html')
  const fontes = ['src', 'public', 'index.html', 'portal.html', 'vite.config.ts', 'package.json']
    .map((nome) => path.join(FRONTEND_DIR, nome))
  // O manual de cobrança entra no bundle (`help-docs`), então conta também.
  fontes.push(path.join(FRONTEND_DIR, '..', 'docs'))
  if (fs.existsSync(dist) && fs.statSync(dist).mtimeMs >= newestMtime(fontes)) return
  console.log('[e2e] building the frontend (dist is missing or older than the sources)…')
  const resultado = spawnSync('npm', ['run', 'build'], { cwd: FRONTEND_DIR, stdio: 'inherit' })
  if (resultado.status !== 0) throw new Error('frontend build failed')
}

async function waitForHealth(url: string, backend: ChildProcess, log: string) {
  const ate = Date.now() + 60_000
  while (Date.now() < ate) {
    if (backend.exitCode !== null) {
      throw new Error(`the backend exited with code ${backend.exitCode}; see ${log}`)
    }
    try {
      const res = await fetch(`${url}/api/health`)
      if (res.ok) return
    } catch {
      // ainda subindo
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`the backend never answered /api/health; see ${log}`)
}

export default async function globalSetup(_config: FullConfig) {
  buildIfStale()

  for (const dir of [SCREENSHOTS_DIR, AUTH_DIR]) fs.mkdirSync(dir, { recursive: true })
  const artefatos = path.join(E2E_DIR, 'test-results')
  fs.mkdirSync(artefatos, { recursive: true })

  const asaasKey = `e2e-${SECRET().slice(0, 16)}`
  const asaas = await startFakeAsaas({ apiKey: asaasKey })

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skygenpanel-e2e-'))
  const port = await freePort()
  const baseURL = `http://127.0.0.1:${port}`

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    APP_ENV: 'test',
    NODE_ENV: 'test',
    EDITION: 'saas',
    DATA_DIR: dataDir,
    DATABASE_URL: '',
    APP_HOST: '127.0.0.1',
    APP_PORT: String(port),
    // Zero: o portal do assinante numa porta qualquer, que nenhum cenário usa.
    PORTAL_PORT: '0',
    JWT_SECRET: SECRET(),
    PORTAL_JWT_SECRET: SECRET(),
    SECRET_BOX_KEY: SECRET(),
    CORS_ORIGINS: baseURL,
    TRUST_PROXY: '0',
    // Host único: o console e os painéis dos provedores no mesmo endereço.
    TENANT_BASE_DOMAIN: '',
    PORTAL_BASE_DOMAIN: '',
    PUBLIC_BASE_URL: baseURL,
    ASAAS_BASE_URL: asaas.url,
    ASAAS_API_KEY: asaasKey,
    // Nada de e-mail de verdade a partir de um `.env` de desenvolvimento.
    SMTP_URL: '',
    MAIL_FROM: ''
  }

  const log = path.join(artefatos, 'backend.log')
  const saida = fs.openSync(log, 'w')
  const preload = path.join(E2E_DIR, 'support', 'allow-fake-asaas.mjs')
  const backend = spawn(process.execPath, ['--import', preload, 'src/server.js'], {
    cwd: BACKEND_DIR,
    env,
    stdio: ['ignore', saida, saida]
  })
  globalThis.__e2e = { backend, asaas, dataDir }
  fs.writeFileSync(path.join(AUTH_DIR, 'run.json'), JSON.stringify({ pid: backend.pid, dataDir, baseURL }))

  await waitForHealth(baseURL, backend, log)

  const setup = await fetch(`${baseURL}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN)
  })
  if (setup.status !== 201) throw new Error(`POST /api/auth/setup answered ${setup.status}: ${await setup.text()}`)
  const { data: { token } } = await setup.json() as { data: { token: string } }
  // O provedor da instalação, onde o admin também é dono, sem o assistente de
  // primeiro acesso no caminho: é o mesmo botão "Pular" da tela.
  for (const what of ['wizard', 'checklist']) {
    const res = await fetch(`${baseURL}/api/settings/onboarding/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ what })
    })
    if (!res.ok) throw new Error(`dismissing the ${what} answered ${res.status}: ${await res.text()}`)
  }

  const seed = spawnSync(process.execPath, ['scripts/seed-demo.js'], { cwd: BACKEND_DIR, env, encoding: 'utf8' })
  fs.appendFileSync(log, `\n--- seed-demo ---\n${seed.stdout}${seed.stderr}\n`)
  if (seed.status !== 0) throw new Error(`seed-demo failed:\n${seed.stdout}${seed.stderr}`)

  // Os cenários (e o `baseURL` do config, relido em cada worker) leem daqui.
  process.env.E2E_BASE_URL = baseURL

  const browser = await chromium.launch(launchOptions())
  try {
    for (const [conta, arquivo] of [[ADMIN, ADMIN_STATE], [PROVIDER, PROVIDER_STATE]] as const) {
      const context = await browser.newContext({ baseURL, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' })
      const page = await context.newPage()
      await loginViaForm(page, conta)
      await context.storageState({ path: arquivo })
      await context.close()
    }
  } finally {
    await browser.close()
  }
}
