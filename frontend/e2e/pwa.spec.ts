import { expect, test } from '@playwright/test'
import { PROVIDER, sessionFor, shot } from './support/demo'

/**
 * O app do provedor (PWA, 0130), no build de produção que o setup serve: o
 * manifest ligado e servido, o service worker registrado e a seção
 * "Notificações neste aparelho" em Minha conta.
 */

test('o painel liga o manifest, e o backend o serve sem cache', async ({ page, request }) => {
  await page.goto('/login')
  const href = await page.locator('link[rel="manifest"]').getAttribute('href')
  expect(href).toBe('/manifest.webmanifest')

  const res = await request.get(href!)
  expect(res.status()).toBe(200)
  expect(res.headers()['content-type']).toMatch(/^application\/manifest\+json/)
  expect(res.headers()['cache-control']).toBe('no-cache')
  const manifest = await res.json()
  expect(manifest.start_url).toBe('/')
  expect(manifest.display).toBe('standalone')
  expect(manifest.name).toBeTruthy()
  expect(manifest.icons.length).toBeGreaterThan(0)
  for (const icon of manifest.icons) {
    const imagem = await request.get(icon.src)
    expect(imagem.status(), icon.src).toBe(200)
  }

  const sw = await request.get('/sw.js')
  expect(sw.status()).toBe(200)
  expect(sw.headers()['cache-control']).toBe('no-cache')
})

test.describe('dentro do painel', () => {
  test.use({ storageState: sessionFor(PROVIDER) })

  test('o service worker registra no build de produção, e a API não passa por ele', async ({ page }) => {
    await page.goto('/dashboard')
    const script = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready
      return reg.active?.scriptURL ?? null
    })
    expect(script).toMatch(/\/sw\.js(\?v=[\w.-]+)?$/)

    // Nenhuma resposta de /api/ guardada no cache do SW.
    await page.reload()
    const guardadas = await page.evaluate(async () => {
      const nomes = await caches.keys()
      const urls: string[] = []
      for (const nome of nomes) {
        const cache = await caches.open(nome)
        for (const req of await cache.keys()) urls.push(new URL(req.url).pathname)
      }
      return urls
    })
    expect(guardadas).toContain('/offline.html')
    expect(guardadas.filter((u) => u.startsWith('/api/'))).toEqual([])
  })

  test('Minha conta mostra as notificações deste aparelho', async ({ page }) => {
    await page.goto('/dashboard')
    await page.getByTestId('sidebar-account-link').first().click()
    await expect(page).toHaveURL(/\/account$/)
    await expect(page.getByRole('heading', { name: 'Minha conta', level: 1 })).toBeVisible()
    const cartao = page.getByTestId('push-notifications-card')
    await expect(cartao.getByRole('heading', { name: 'Notificações neste aparelho' })).toBeVisible()
    await expect(cartao.getByRole('button', { name: 'Ativar neste aparelho' })).toBeVisible()
    // O dono vê também o aviso de fatura entre os eventos.
    await expect(cartao.getByRole('checkbox', { name: 'Fatura nova ou vencida' })).toBeVisible()
    await shot(page, 'pwa-01-account-notifications')
  })
})
