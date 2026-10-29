import { expect, test } from '@playwright/test'
import {
  ADMIN, ADMIN_STATE, DELINQUENT_PROVIDER, SUSPENDED_PROVIDER, consoleTabs, loginViaForm, openConsole, shot
} from './support/demo'

/**
 * O console da plataforma, pelo navegador, com os dados do `seed-demo.js`.
 *
 * Os seletores são os do usuário: papéis e textos do pt-BR. Um texto que muda
 * quebra o teste de propósito — é o que a pessoa lê na tela.
 */

test.describe('login', () => {
  test('quem opera a plataforma entra pela tela de login e chega ao console', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('#identifier')).toBeVisible()
    await shot(page, 'console-01-login')

    await loginViaForm(page, ADMIN)
    await openConsole(page)
    await expect(consoleTabs(page).getByRole('button', { name: 'Receita' })).toBeVisible()
    await shot(page, 'console-02-after-login')
  })
})

test.describe('console', () => {
  test.use({ storageState: ADMIN_STATE })

  test.beforeEach(async ({ page }) => {
    await page.goto('/platform')
    await expect(consoleTabs(page)).toBeVisible()
  })

  test('Receita mostra o resumo e os gráficos', async ({ page }) => {
    await consoleTabs(page).getByRole('button', { name: 'Receita', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Resumo', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Recebido e estornado por mês' })).toBeVisible()
    // O gráfico de barras do período e os da evolução mês a mês.
    await expect(page.getByRole('img', { name: /Gráfico de barras com o recebido/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Evolução mês a mês' })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await shot(page, 'console-03-revenue')
  })

  test('Inadimplência: filtra e dá prazo pela confirmação', async ({ page }) => {
    await consoleTabs(page).getByRole('button', { name: 'Inadimplência', exact: true }).click()
    const tabela = page.locator('table.modern-table')
    await expect(tabela.getByText(DELINQUENT_PROVIDER)).toBeVisible()
    await expect(tabela.getByText(SUSPENDED_PROVIDER)).toBeVisible()
    await shot(page, 'console-04-delinquency')

    // O filtro por nome deixa só o vencido.
    await page.getByRole('searchbox', { name: 'Buscar provedor' })
      .or(page.getByRole('textbox', { name: 'Buscar provedor' }))
      .fill('Beta')
    await expect(tabela.getByText(SUSPENDED_PROVIDER)).toBeHidden()
    await expect(tabela.getByText(DELINQUENT_PROVIDER)).toBeVisible()
    await shot(page, 'console-05-delinquency-filtered')

    await page.getByRole('checkbox', { name: `Selecionar ${DELINQUENT_PROVIDER}` }).check()
    await page.getByRole('region', { name: 'Ações em massa' }).getByRole('button', { name: 'Dar prazo' }).click()

    const dialogo = page.getByRole('dialog')
    await expect(dialogo).toBeVisible()
    await expect(dialogo.getByText(/Dar mais dias de prazo a 1 provedor/)).toBeVisible()
    await dialogo.getByLabel('Dias a mais (1 a 60)').fill('10')
    await dialogo.getByLabel('Motivo (opcional)').fill('Teste no navegador')
    await shot(page, 'console-06-delinquency-confirm', { fullPage: false })
    await dialogo.getByRole('button', { name: 'Confirmar' }).click()

    await expect(dialogo).toBeHidden()
    await expect(page.getByRole('heading', { name: /Dar prazo: 1 de 1 concluído/ })).toBeVisible()
    // Com o prazo dado a renovação foi para a frente: a Beta sai da lista.
    await expect(tabela.getByText(DELINQUENT_PROVIDER)).toBeHidden()
    await expect(tabela.getByText('Nenhum provedor com esses filtros.')).toBeVisible()
    await shot(page, 'console-07-delinquency-extended')
  })

  test('Configurações → Alertas → Histórico mostra o alerta que falhou e o reenvia', async ({ page }) => {
    await consoleTabs(page).getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('navigation', { name: 'Configurações' }).getByRole('button', { name: 'Alertas' }).click()
    await page.getByRole('tab', { name: 'Histórico' }).click()

    await expect(page.getByRole('heading', { name: 'Histórico de alertas' })).toBeVisible()
    const linha = page.getByRole('row').filter({ hasText: `Cartão recusado: ${DELINQUENT_PROVIDER}` })
    await expect(linha).toBeVisible()
    await expect(linha.getByText('Falhou')).toBeVisible()
    await shot(page, 'console-08-alert-history')

    // O "Reenviar" pergunta antes (window.confirm) e põe o alerta de volta na fila.
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('Colocar este alerta de volta na fila?')
      void dialog.accept()
    })
    await linha.getByRole('button', { name: 'Reenviar' }).click()
    await expect(page.getByText('Alerta de volta na fila.')).toBeVisible()
    await expect(linha.getByText('Pendente')).toBeVisible()
    await shot(page, 'console-09-alert-resent')
  })

  test('Ajuda: o manual com busca', async ({ page }) => {
    await consoleTabs(page).getByRole('button', { name: 'Ajuda', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Manual de cobrança da plataforma' })).toBeVisible()
    const busca = page.getByRole('searchbox', { name: 'Buscar no manual' })
    await busca.fill('webhook')
    await expect(page.getByRole('heading', { name: /Webhook: endereço e token/ })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Planos', exact: true })).toBeHidden()
    await shot(page, 'console-10-help-search')

    await busca.fill('nada-disso-existe-no-manual')
    await expect(page.getByText('Nada encontrado para "nada-disso-existe-no-manual".')).toBeVisible()
  })
})
