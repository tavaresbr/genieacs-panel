import { expect, test } from '@playwright/test'
import { ADMIN, DELTA_OWNER, RENEWING_PROVIDER, consoleTabs, loginViaForm, sessionFor, shot } from './support/demo'

/**
 * Os primeiros passos do provedor, dos dois lados.
 *
 * A Delta Link é a única do seed com o checklist à vista (`keepChecklist` em
 * `seed-demo.js`): o card do Início mostra o percentual e destaca o próximo
 * passo. No console, a lista de Provedores mostra o percentual de cada um e
 * filtra os "travados".
 */

test('o Início de um provedor novo mostra o checklist com o percentual e o próximo passo', async ({ page }) => {
  await loginViaForm(page, DELTA_OWNER)
  await page.goto('/dashboard')
  const card = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Primeiros passos', exact: true }) })
  await expect(card).toBeVisible()
  await expect(card.getByTestId('onboarding-percent')).toHaveText(/^\d{1,2}% concluído$/)
  const barra = card.getByRole('progressbar')
  await expect(barra).toHaveAttribute('aria-valuemax', '100')

  // O próximo passo, destacado, com o link para a tela onde se resolve.
  const proximo = card.locator('li[data-next]')
  await expect(proximo).toHaveCount(1)
  await expect(proximo.getByText('Próximo passo', { exact: true })).toBeVisible()
  await expect(proximo.getByRole('link')).toHaveAttribute('href', /\/(settings|devices|whatsapp)/)
  // O contato de cobrança veio do cadastro do seed: já aparece feito.
  await expect(card.getByText('Contato de cobrança', { exact: true })).toBeVisible()
  await card.scrollIntoViewIfNeeded()
  await shot(page, 'onboarding-01-dashboard-checklist')
})

test.describe('no console', () => {
  test.use({ storageState: sessionFor(ADMIN) })

  test('a lista de Provedores mostra o onboarding de cada um e filtra os travados', async ({ page }) => {
    await page.goto('/platform')
    await expect(consoleTabs(page)).toBeVisible()
    await consoleTabs(page).getByRole('button', { name: 'Provedores', exact: true }).click()

    const linha = page.getByRole('row').filter({ has: page.getByText(RENEWING_PROVIDER, { exact: true }) })
    await expect(linha.getByTestId('tenant-onboarding')).toContainText(/\d{1,3}%/)
    await shot(page, 'onboarding-02-console-column')

    // Os provedores do seed nasceram agora: nenhum passou dos 7 dias.
    await page.getByRole('button', { name: /^Travados \(\d+\)$/ }).click()
    await expect(page.getByText('Nenhum provedor travado no onboarding.')).toBeVisible()
    await page.getByRole('button', { name: 'Todos', exact: true }).click()
    await expect(linha).toBeVisible()
  })
})
