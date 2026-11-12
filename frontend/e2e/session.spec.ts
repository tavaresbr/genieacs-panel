import { expect, test } from '@playwright/test'
import { PROVIDER, loginViaForm, shot } from './support/demo'

/**
 * O login com cookie seguro (0129): o token de acesso mora só na memória da
 * aba, e o refresh num cookie `HttpOnly`. Recarregar a página tem que manter a
 * pessoa dentro — a tela pede um token novo ao `/api/auth/refresh` logo ao
 * carregar — e a tela "Sessões ativas" mostra este aparelho.
 */
test.describe('a sessão por cookie', () => {
  test('recarregar a página mantém o login, sem token em storage', async ({ page }) => {
    await loginViaForm(page, PROVIDER)
    await expect(page).toHaveURL(/\/dashboard/)

    await page.reload()
    await expect(page).toHaveURL(/\/dashboard/)
    await expect(page.getByRole('navigation', { name: 'Principal' })).toBeVisible()

    // Nada de token legível por script.
    const guardado = await page.evaluate(() => ({
      token: localStorage.getItem('token'),
      refresh: localStorage.getItem('refreshToken'),
      cookies: document.cookie
    }))
    expect(guardado.token).toBeNull()
    expect(guardado.refresh).toBeNull()
    expect(guardado.cookies).not.toContain('skg_rt')

    // Outra aba do mesmo navegador entra pelo mesmo cookie.
    const outra = await page.context().newPage()
    await outra.goto('/dashboard')
    await expect(outra).toHaveURL(/\/dashboard/)
    await expect(outra.getByRole('navigation', { name: 'Principal' })).toBeVisible()
    await outra.close()
  })

  test('"Sair dos outros" encerra só os outros aparelhos, depois de confirmar', async ({ page, browser }) => {
    await loginViaForm(page, PROVIDER)

    // Um segundo navegador entra com a mesma conta: é um aparelho a mais.
    const contexto = await browser.newContext({ locale: 'pt-BR' })
    const outro = await contexto.newPage()
    await loginViaForm(outro, PROVIDER)

    await page.goto('/settings?tab=security')
    const cartao = page.getByTestId('active-sessions')
    const botao = cartao.getByRole('button', { name: 'Sair dos outros' })
    await expect(botao).toBeVisible()
    const antes = await cartao.getByRole('listitem').count()
    expect(antes).toBeGreaterThanOrEqual(2)

    // Cancelar não encerra nada.
    await botao.click()
    await expect(page.getByTestId('confirm-dialog')).toBeVisible()
    await page.getByRole('button', { name: 'Cancelar' }).click()
    await expect(cartao.getByRole('listitem')).toHaveCount(antes)

    // Confirmar encerra os outros; este aparelho fica.
    await botao.click()
    await page.getByTestId('confirm-dialog-confirm').click()
    await expect(cartao.getByRole('listitem')).toHaveCount(1)
    await expect(cartao.getByText('Este aparelho', { exact: true })).toBeVisible()
    await expect(botao).toBeHidden()
    await shot(page, 'session-02-revoke-others')
    await contexto.close()
  })

  test('as sessões ativas listam este aparelho, e "Sair" leva ao login', async ({ page }) => {
    await loginViaForm(page, PROVIDER)
    await page.goto('/settings?tab=security')
    const cartao = page.getByTestId('active-sessions')
    await expect(cartao.getByRole('heading', { name: 'Sessões ativas' })).toBeVisible()
    await expect(cartao.getByText('Este aparelho', { exact: true })).toBeVisible()
    await expect(cartao.getByRole('button', { name: 'Sair de todos' })).toBeEnabled()
    await shot(page, 'session-01-active-sessions')

    // Encerrar a sessão deste aparelho pela lista leva ao login, e um F5
    // depois disso não volta para dentro.
    const atual = cartao.getByRole('listitem').filter({ hasText: 'Este aparelho' })
    await atual.getByRole('button', { name: 'Encerrar' }).click()
    // A confirmação é um diálogo do painel (não o `window.confirm`).
    await page.getByTestId('confirm-dialog-confirm').click()
    await expect(page).toHaveURL(/\/login/)
    await page.reload()
    await expect(page).toHaveURL(/\/login/)
  })
})
