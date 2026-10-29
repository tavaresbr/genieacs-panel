import { defineConfig, devices } from '@playwright/test'
import { launchOptions } from './e2e/support/demo'

/**
 * Os testes no navegador (`npm run e2e`): o painel de verdade, buildado e
 * servido pelo backend de verdade na edição SaaS, com o banco montado pelo
 * `backend/scripts/seed-demo.js` — ver `e2e/global-setup.ts`.
 *
 * Um worker só e em ordem: há UM backend e UM banco, e alguns cenários mudam o
 * que outros leem (o "Dar prazo" tira um provedor da lista de devedores).
 *
 * `baseURL` vem do setup, que escolhe a porta: o config é relido em cada
 * worker, e o worker herda o ambiente que o setup deixou.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  outputDir: './e2e/test-results/artifacts',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: './e2e/report', open: 'never' }]
  ],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: process.env.E2E_BASE_URL,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: launchOptions()
  }
})
