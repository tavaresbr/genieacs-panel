import { expect, test } from '@playwright/test'
import { ADMIN_STATE, DEMO_AFFILIATE, consoleTabs, shot } from './support/demo'

/**
 * O programa de afiliados (0125) no navegador: o console cadastra um
 * afiliado e gera o link de senha, que abre o portal `/afiliados`; o lote do
 * mês anterior da afiliada do seed é montado, aprovado e pago — o Pix vai ao
 * Asaas de mentira (`support/fake-asaas.mjs`, `/transfers`), nunca a um banco.
 * Por fim, a afiliada do seed entra no portal e vê o extrato.
 */
test.describe.configure({ mode: 'serial' })

const NOVO = { name: 'Diego Divulga (e2e)', email: 'diego@afiliados-e2e.test', pix: 'diego@pix-e2e.test' }

test.describe('o console', () => {
  test.use({ storageState: ADMIN_STATE, permissions: ['clipboard-read', 'clipboard-write'] })

  test.beforeEach(async ({ page }) => {
    await page.goto('/platform')
    await consoleTabs(page).getByRole('button', { name: 'Afiliados', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Afiliados', exact: true })).toBeVisible()
  })

  test('cadastra um afiliado aprovado e o link de senha abre o portal', async ({ page, context }) => {
    await page.getByRole('button', { name: 'Novo afiliado' }).click()
    await page.getByLabel('Nome', { exact: true }).fill(NOVO.name)
    await page.getByLabel('E-mail', { exact: true }).fill(NOVO.email)
    await page.getByLabel('Tipo da chave Pix').selectOption('EMAIL')
    await page.getByLabel('Chave Pix', { exact: true }).fill(NOVO.pix)
    await expect(page.getByLabel('Aprovar agora')).toBeChecked()
    await shot(page, 'affiliates-01-console-form')
    await page.getByRole('button', { name: 'Cadastrar afiliado' }).click()
    await expect(page.getByText('Afiliado cadastrado').first()).toBeVisible()

    const cartao = page.getByRole('listitem').filter({ hasText: NOVO.email })
    await expect(cartao.getByText('Ativo', { exact: true })).toBeVisible()
    await expect(cartao.getByText(/^A-[A-Z0-9]{7}$/)).toBeVisible()

    // O link de senha vai para a área de transferência (ou para um prompt,
    // quando o navegador não deixa copiar).
    let doPrompt: string | null = null
    page.once('dialog', (dialog) => {
      doPrompt = dialog.defaultValue()
      void dialog.accept()
    })
    await cartao.getByRole('button', { name: 'Link de senha' }).click()
    await expect(page.getByText(/Link de senha copiado|Afiliado/).first()).toBeVisible()
    const link = doPrompt ?? await page.evaluate(() => navigator.clipboard.readText())
    expect(link).toMatch(/\/afiliados#senha=[0-9a-f]{64}$/)
    await shot(page, 'affiliates-02-console-created')

    // O afiliado define a senha pelo link, num navegador sem sessão nenhuma.
    // Sem a sessão do console: o `browser` do Playwright Test aplica o
    // `storageState` do projeto a todo contexto novo, e um refresh feito aqui
    // giraria o token guardado em `ADMIN_STATE` para os outros cenários.
    const portal = await context.browser()!.newContext({ baseURL: process.env.E2E_BASE_URL, storageState: { cookies: [], origins: [] }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' })
    const aba = await portal.newPage()
    await aba.goto(link)
    await expect(aba.getByText('Defina sua senha')).toBeVisible()
    await expect(aba).toHaveURL(/\/afiliados$/)
    await aba.getByLabel('Senha', { exact: true }).fill('Diego-Divulga-2026')
    await aba.getByLabel('Confirme a senha').fill('Diego-Divulga-2026')
    await shot(aba, 'affiliates-03-portal-set-password')
    await aba.getByRole('button', { name: 'Salvar senha' }).click()
    await expect(aba.getByRole('heading', { name: 'Seu link de indicação' })).toBeVisible()
    await expect(aba.getByText(/Chave Pix: EMAIL/)).toBeVisible()
    await shot(aba, 'affiliates-04-portal-new-affiliate')
    await portal.close()
  })

  test('o lote do mês anterior: montar, aprovar, enviar o Pix (Asaas de mentira) e consultar', async ({ page }) => {
    // O agendador também monta nos dias 1 a 3: o botão pode não criar nada
    // novo, mas o lote da Carla tem de estar lá depois dele.
    await page.getByRole('button', { name: 'Montar mês anterior' }).click()
    await expect(page.getByText(/lote\(s\) criado\(s\)/).first()).toBeVisible()
    const lote = page.locator('li.modern-card').filter({ hasText: `${DEMO_AFFILIATE.name} · ` })
    await expect(lote).toBeVisible()
    await expect(lote.getByText('Rascunho')).toBeVisible()
    await expect(lote.getByText(/R\$\s?79,80 · 2 comissão\(ões\)/)).toBeVisible()
    await shot(page, 'affiliates-05-payout-draft')

    await lote.getByRole('button', { name: 'Aprovar' }).click()
    await expect(lote.getByText('Aprovado', { exact: true })).toBeVisible()
    await shot(page, 'affiliates-06-payout-approved')

    const pergunta = new Promise<string>((resolve) => {
      page.once('dialog', (dialog) => {
        resolve(dialog.message())
        void dialog.accept()
      })
    })
    await lote.getByRole('button', { name: 'Enviar Pix' }).click()
    expect(await pergunta).toMatch(/Enviar R\$\s?79,80 por Pix para Carla Indica\?/)
    await expect(lote.getByText('Enviado', { exact: true })).toBeVisible()
    await shot(page, 'affiliates-07-payout-sent')

    await lote.getByRole('button', { name: 'Consultar status' }).click()
    await expect(lote.getByText('Pago', { exact: true })).toBeVisible()
    await shot(page, 'affiliates-08-payout-paid')
  })
})

test.describe('o portal do afiliado', () => {
  test('a afiliada do seed entra e vê indicados, extrato e o pagamento', async ({ page }) => {
    await page.goto('/afiliados')
    await expect(page.getByRole('heading', { name: 'Entrar como afiliado' })).toBeVisible()
    await shot(page, 'affiliates-09-portal-login')
    await page.getByLabel('E-mail', { exact: true }).fill(DEMO_AFFILIATE.email)
    await page.getByLabel('Senha', { exact: true }).fill(DEMO_AFFILIATE.password)
    await page.getByRole('button', { name: 'Entrar', exact: true }).click()

    await expect(page.getByRole('heading', { name: 'Seu link de indicação' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Provedores indicados' })).toBeVisible()
    // O indicado com o nome mascarado — nunca "Delta Link" inteiro.
    await expect(page.getByText('Delta Link', { exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Extrato' })).toBeVisible()
    await expect(page.getByText(/R\$\s?39,90/).first()).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Pagamentos' })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await shot(page, 'affiliates-10-portal-overview')
  })
})
