import { expect, test } from '@playwright/test'
// @ts-expect-error -- módulo JS puro, sem tipos.
import { FAKE_BOLETO_LINE, FAKE_PIX_PAYLOAD } from './support/fake-asaas.mjs'
import { PROVIDER, PROVIDER_STATE, loginViaForm, shot } from './support/demo'

/**
 * O painel de um provedor (Alfa Fibra, em dia, no mensal do Essencial), na
 * tela de Plano: as faturas, a segunda via lida do Asaas de mentira, o guia de
 * cobrança e a troca de plano com a prévia da pró-rata.
 */

test('o dono do provedor entra pela tela de login', async ({ page }) => {
  await loginViaForm(page, PROVIDER)
  await expect(page).toHaveURL(/\/dashboard/)
  await shot(page, 'provider-01-after-login')
})

test.describe('Plano', () => {
  test.use({ storageState: PROVIDER_STATE })

  test.beforeEach(async ({ page }) => {
    await page.goto('/plan')
    await expect(page.getByRole('heading', { name: 'Plano e uso', level: 1 })).toBeVisible()
  })

  test('lista as faturas e abre a segunda via', async ({ page }) => {
    // A seção mais de dentro que tem o título: o cartão das cobranças.
    const cobrancas = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Cobranças', exact: true }) }).last()
    // As três pagas do seed, com recibo, e a do próximo período em aberto.
    await expect(cobrancas.getByRole('listitem')).toHaveCount(4)
    await expect(cobrancas.getByRole('button', { name: 'Baixar recibo' })).toHaveCount(3)
    await expect(cobrancas.getByRole('button', { name: 'Segunda via' })).toHaveCount(1)
    await shot(page, 'provider-02-plan-invoices')

    await cobrancas.getByRole('button', { name: 'Segunda via' }).click()
    const dialogo = page.getByRole('dialog', { name: 'Pagar esta cobrança' })
    await expect(dialogo).toBeVisible()
    await expect(dialogo.getByLabel('Pix copia e cola')).toHaveValue(FAKE_PIX_PAYLOAD)
    await expect(dialogo.getByLabel('Linha digitável do boleto')).toHaveValue(FAKE_BOLETO_LINE)
    await shot(page, 'provider-03-second-copy', { fullPage: false })
    await dialogo.getByRole('button', { name: 'Fechar' }).last().click()
    await expect(dialogo).toBeHidden()
  })

  test('abre o "Como funciona"', async ({ page }) => {
    await page.getByRole('button', { name: 'Como funciona' }).click()
    const guia = page.getByRole('dialog', { name: 'Como funciona a cobrança' })
    await expect(guia).toBeVisible()
    await expect(guia.getByRole('searchbox', { name: 'Buscar no manual' })).toBeVisible()
    await shot(page, 'provider-04-billing-guide', { fullPage: false })
  })

  test('a troca para um plano maior mostra a pró-rata antes de cobrar', async ({ page }) => {
    const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Profissional' }) })
    // A prévia no próprio cartão do plano, antes de qualquer clique.
    await expect(card.getByText(/Subindo agora: R\$\s?133,3\d de pró-rata \(20 dias restantes\)/)).toBeVisible()
    await shot(page, 'provider-05-plan-change-preview')

    // E na confirmação: dispensada, para nada ser cobrado do provedor de teste.
    const mensagem = new Promise<string>((resolve) => {
      page.once('dialog', (dialog) => {
        resolve(dialog.message())
        void dialog.dismiss()
      })
    })
    await card.getByRole('button', { name: 'Mudar para este plano' }).click()
    expect(await mensagem).toMatch(/Você vai pagar R\$\s?133,3\d agora \(20 dias restantes\)\./)
    await expect(card.getByText('Plano atual')).toHaveCount(0)
  })
})
