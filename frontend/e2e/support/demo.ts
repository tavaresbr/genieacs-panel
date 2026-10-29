import path from 'node:path'
import { expect, type Page } from '@playwright/test'

/**
 * O que os cenários sabem do ambiente: as contas que o `global-setup` cria
 * (o admin pelo `POST /api/auth/setup`, os provedores pelo
 * `backend/scripts/seed-demo.js`, que tem as mesmas senhas) e onde as coisas
 * ficam no disco.
 */

// `__dirname` e não `import.meta`: o pacote do frontend é CommonJS, e é assim
// que o Playwright transpila estes arquivos.
export const E2E_DIR = path.resolve(__dirname, '..')
export const FRONTEND_DIR = path.resolve(E2E_DIR, '..')
export const REPO_DIR = path.resolve(FRONTEND_DIR, '..')
export const BACKEND_DIR = path.join(REPO_DIR, 'backend')

export const SCREENSHOTS_DIR = path.join(E2E_DIR, 'screenshots')
export const AUTH_DIR = path.join(E2E_DIR, '.auth')
export const ADMIN_STATE = path.join(AUTH_DIR, 'admin.json')
export const PROVIDER_STATE = path.join(AUTH_DIR, 'provider.json')

/** Quem opera a plataforma: o primeiro usuário, criado pelo setup. */
export const ADMIN = {
  username: 'plataforma',
  email: 'admin@plataforma.test',
  password: 'Plataforma-E2E-2026'
} as const

/** O dono da Alfa Fibra, em dia e no mensal — ver `seed-demo.js`. */
export const PROVIDER = {
  name: 'Alfa Fibra',
  email: 'dono@alfa-fibra.test',
  password: 'Alfa-Demo-2026'
} as const

/** Os outros dois provedores do seed. */
export const DELINQUENT_PROVIDER = 'Beta Net'
export const SUSPENDED_PROVIDER = 'Gama Telecom'

/**
 * Uma captura em `e2e/screenshots/<nome>.png`: a página inteira, ou só a tela
 * (`fullPage: false`) quando há um diálogo aberto — o fundo esticado de uma
 * captura longa corta o diálogo e a barra lateral fixa no meio.
 */
export async function shot(page: Page, nome: string, { fullPage = true } = {}) {
  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${nome}.png`), fullPage })
}

/**
 * Entra pela tela de login, como uma pessoa entraria, e espera sair dela.
 *
 * Num deploy de host único (sem `TENANT_BASE_DOMAIN`) o login leva ao painel do
 * provedor da pessoa — inclusive quem opera a plataforma, que também é dono do
 * primeiro provedor. O console fica em `/platform`, pelo item "Provedores" da
 * barra lateral (`openConsole`).
 */
export async function loginViaForm(page: Page, conta: { email: string, password: string }) {
  await page.goto('/login')
  await page.locator('#identifier').fill(conta.email)
  await page.locator('#password').fill(conta.password)
  await page.getByRole('button', { name: 'Entrar', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

/** Do painel ao console, pelo item da barra lateral. */
export async function openConsole(page: Page) {
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: /^Provedores/ }).click()
  await expect(page).toHaveURL(/\/platform$/)
  await expect(consoleTabs(page)).toBeVisible()
}

/** A barra de abas do console. */
export function consoleTabs(page: Page) {
  // O rótulo da barra é o título da página (`platform.title`).
  return page.getByRole('navigation', { name: 'Provedores', exact: true })
}

/**
 * `E2E_CHROMIUM_PATH` aponta um Chromium já instalado, para quando a versão
 * do Playwright não casar com a do navegador da máquina. Sem ela, vale o que o
 * Playwright acha sozinho (`PLAYWRIGHT_BROWSERS_PATH` ou o cache dele).
 */
export function launchOptions() {
  return process.env.E2E_CHROMIUM_PATH ? { executablePath: process.env.E2E_CHROMIUM_PATH } : {}
}
