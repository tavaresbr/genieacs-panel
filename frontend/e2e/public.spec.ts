import { expect, test } from '@playwright/test'
import { E2E_NPS_TOKEN, PROVIDER, receiptToken, shot } from './support/demo'

/**
 * As páginas públicas abertas por um link com token no FRAGMENTO, sem sessão:
 * a pesquisa de satisfação (`/nps#<token>`, a pendente da Alfa que o seed cria
 * só no banco de teste) e o recibo do bot da plataforma (`/receipt#<token>`,
 * cunhado pelo `global-setup` com o util do backend).
 *
 * O que importa nas duas: o token sai da barra assim que é lido (não fica no
 * histórico) e vai ao servidor no CORPO de um POST, nunca no caminho.
 */

test.describe('a pesquisa de satisfação pelo link', () => {
  test('abre pelo fragmento, responde e mostra o agradecimento', async ({ page }) => {
    const caminhos: string[] = []
    page.on('request', (req) => { caminhos.push(new URL(req.url()).pathname) })

    await page.goto(`/nps#${E2E_NPS_TOKEN}`)
    await expect(page.getByRole('heading', { name: 'Pesquisa de satisfação' })).toBeVisible()
    await expect(page.getByRole('radiogroup', { name: 'Pesquisa de satisfação' })).toBeVisible()
    // O token saiu da barra.
    await expect(page).toHaveURL(/\/nps$/)
    await shot(page, 'public-01-nps-open')

    await page.getByRole('radio', { name: 'Nota 9' }).click()
    await expect(page.getByRole('radio', { name: 'Nota 9' })).toHaveAttribute('aria-checked', 'true')
    await page.getByLabel('Quer contar o porquê? (opcional)').fill('Teste no navegador: o painel é rápido.')
    await page.getByRole('button', { name: 'Enviar resposta' }).click()
    await expect(page.getByText('Obrigado! Sua resposta foi registrada.')).toBeVisible()
    await shot(page, 'public-02-nps-answered')

    expect(caminhos).toContain('/api/public/nps/lookup')
    expect(caminhos).toContain('/api/public/nps/answer')
    expect(caminhos.some((c) => c.includes(E2E_NPS_TOKEN))).toBe(false)
  })

  test('um token que não existe diz que o link não vale', async ({ page }) => {
    await page.goto(`/nps#${'x'.repeat(43)}`)
    await expect(page.getByText('Este link de pesquisa não é válido.')).toBeVisible()
  })
})

test.describe('o recibo pelo link do bot', () => {
  test('abre pelo fragmento, num iframe sem scripts', async ({ page }) => {
    const token = receiptToken()
    const caminhos: string[] = []
    page.on('request', (req) => { caminhos.push(new URL(req.url()).pathname) })

    await page.goto(`/receipt#${token}`)
    await expect(page.getByRole('heading', { name: 'Recibo de pagamento' })).toBeVisible()
    const quadro = page.locator('iframe[title="Recibo"]')
    await expect(quadro).toBeVisible()
    // `sandbox` vazio: nem script, nem a mesma origem.
    await expect(quadro).toHaveAttribute('sandbox', '')
    await expect(page.frameLocator('iframe[title="Recibo"]').getByText(PROVIDER.name).first()).toBeVisible()
    await expect(page).toHaveURL(/\/receipt$/)
    await expect(page.getByRole('button', { name: 'Abrir em nova aba' })).toBeVisible()
    await shot(page, 'public-03-receipt')

    expect(caminhos).toContain('/api/public/receipt')
    expect(caminhos.some((c) => c.includes(token))).toBe(false)
  })

  test('um token adulterado é o mesmo "não vale mais"', async ({ page }) => {
    const [corpo, assinatura] = receiptToken().split('.')
    const trocada = `${assinatura.slice(0, -1)}${assinatura.endsWith('A') ? 'B' : 'A'}`
    await page.goto(`/receipt#${corpo}.${trocada}`)
    await expect(page.getByText('Este link de recibo não vale mais. Peça um novo pelo WhatsApp.')).toBeVisible()
    await expect(page.locator('iframe')).toHaveCount(0)
    await shot(page, 'public-04-receipt-invalid')
  })
})
