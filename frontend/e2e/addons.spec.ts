import { expect, test } from '@playwright/test'
import { ADMIN_STATE, DELTA_OWNER, consoleTabs, loginViaForm, shot } from './support/demo'

/**
 * Os add-ons pagos (0127), de ponta a ponta: o console cria um no catálogo, e
 * o dono da Delta Link (cobrada por fora — nenhuma fatura vai ao gateway) o
 * vê na tela de Plano com a prévia da pró-rata, ativa e cancela.
 *
 * Em ordem: o segundo cenário usa o add-on que o primeiro cria.
 */
test.describe.configure({ mode: 'serial' })

const CODIGO = 'e2e-relatorios'
const NOME = 'Relatórios avançados (e2e)'

test.describe('o catálogo no console', () => {
  test.use({ storageState: ADMIN_STATE })

  test('Planos → Add-ons: cria um add-on de recurso e mostra o aviso antes de exigi-lo', async ({ page }) => {
    await page.goto('/platform')
    await consoleTabs(page).getByRole('button', { name: 'Planos', exact: true }).click()
    const secao = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Add-ons', exact: true }) })
    await secao.getByRole('button', { name: 'Novo add-on' }).click()
    await secao.getByLabel('Código').fill(CODIGO)
    await secao.getByLabel('Nome', { exact: true }).fill(NOME)
    await secao.getByLabel('Descrição').fill('Exportações e gráficos a mais, criados pelo teste no navegador.')
    await secao.getByLabel('Preço mensal (R$)').fill('90,00')
    await secao.getByLabel('Chave do recurso').fill('reports-e2e')
    await shot(page, 'addons-01-console-form')
    await secao.getByRole('button', { name: 'Salvar', exact: true }).click()
    await expect(page.getByText('Add-on salvo').first()).toBeVisible()
    const linha = secao.getByRole('listitem').filter({ hasText: NOME })
    await expect(linha).toBeVisible()
    await expect(linha.getByText('0 ativos')).toBeVisible()

    // Ligar "Exigido" num add-on que ninguém tem: o console diz quantos
    // provedores ativos perderiam o recurso — e o teste NÃO salva.
    await linha.getByRole('button', { name: 'Editar' }).click()
    await secao.getByLabel(/Exigido para o recurso/).check()
    await expect(secao.getByTestId('addon-gate-impact')).toContainText(/provedor\(es\) ativo\(s\) perderiam o acesso/)
    await expect(secao.getByText(/vale também no fundo/)).toBeVisible()
    await shot(page, 'addons-02-console-gate-warning')
    await secao.getByRole('button', { name: 'Cancelar', exact: true }).first().click()
  })
})

test.describe('na tela de Plano do provedor', () => {
  test('ativa com a prévia da pró-rata e cancela na renovação', async ({ page }) => {
    await loginViaForm(page, DELTA_OWNER)
    await page.goto('/plan')
    await expect(page.getByRole('heading', { name: 'Plano e uso', level: 1 })).toBeVisible()
    const cartao = page.getByRole('listitem').filter({ has: page.getByText(NOME, { exact: true }) })
    await expect(cartao).toBeVisible()
    await expect(cartao.getByText('Disponível')).toBeVisible()
    // A Delta renova em 4 dias: a pró-rata é uma fração dos R$ 90,00.
    await expect(cartao.getByText(/Ativar agora cobra R\$\s?\d+,\d\d pelos \d+ dias que faltam do período atual\./)).toBeVisible()
    await cartao.scrollIntoViewIfNeeded()
    await shot(page, 'addons-03-provider-preview')

    const confirmacao = new Promise<string>((resolve) => {
      page.once('dialog', (dialog) => {
        resolve(dialog.message())
        void dialog.accept()
      })
    })
    await cartao.getByRole('button', { name: 'Ativar' }).click()
    expect(await confirmacao).toMatch(/Ativar Relatórios avançados \(e2e\)\? Sai agora uma fatura de R\$\s?\d+,\d\d/)
    await expect(cartao.getByText('Ativo', { exact: true })).toBeVisible()
    await shot(page, 'addons-04-provider-active')

    page.once('dialog', (dialog) => { void dialog.accept() })
    await cartao.getByRole('button', { name: 'Cancelar na renovação' }).click()
    await expect(cartao.getByText('Cancela na renovação')).toBeVisible()
    await expect(cartao.getByText(/Ativo até \d{2}\/\d{2}\/\d{4}/)).toBeVisible()
    await expect(cartao.getByRole('button', { name: 'Manter add-on' })).toBeVisible()
    await shot(page, 'addons-05-provider-cancel-scheduled')
  })
})
