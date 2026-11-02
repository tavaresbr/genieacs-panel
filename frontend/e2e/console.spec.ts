import fs from 'node:fs'
import { expect, test } from '@playwright/test'
import {
  ADMIN, ADMIN_STATE, DELINQUENT_PROVIDER, RENEWING_PROVIDER, SCREENSHOTS_DIR, SUSPENDED_PROVIDER, consoleTabs,
  loginViaForm, openConsole, shot
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

  // Antes da Inadimplência e do Histórico de alertas: os dois mudam o que a
  // Início conta (o "Dar prazo" tira a Beta da lista; o "Reenviar" tira o
  // alerta das falhas).
  test('Início: os cartões com os dados do seed, o atalho para a Inadimplência e a aba na URL', async ({ page }) => {
    await expect(consoleTabs(page).getByRole('button', { name: 'Início', exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible()

    // Inadimplência: a Beta (vencida) e a Gama (suspensa por falta de pagamento).
    const inadimplencia = page.getByRole('button', { name: 'Abrir: Inadimplência' })
    await expect(inadimplencia).toBeVisible()
    await expect(inadimplencia.getByText(/2 provedor\(es\)/)).toBeVisible()
    // O alerta de cartão recusado que o seed deixou falhando.
    const alertas = page.getByRole('button', { name: 'Abrir: Configurações' })
    await expect(alertas.getByText('Alertas com falha')).toBeVisible()
    await expect(alertas.getByText('1', { exact: true })).toBeVisible()
    // A Delta renova em quatro dias: está na lista da semana.
    const renovacoes = page.locator('.modern-card').filter({
      has: page.getByRole('heading', { name: 'Renovações nos próximos 7 dias' })
    })
    await expect(renovacoes.getByText(RENEWING_PROVIDER)).toBeVisible()
    await expect(renovacoes.getByText('Pagamento manual')).toBeVisible()
    await page.waitForLoadState('networkidle')
    await shot(page, 'console-11-home')

    // O cartão leva à aba do detalhe, e a aba vai para a URL.
    await inadimplencia.click()
    await expect(page).toHaveURL(/[?&]tab=delinquency\b/)
    await expect(page.locator('table.modern-table').getByText(DELINQUENT_PROVIDER)).toBeVisible()
    await shot(page, 'console-12-home-to-delinquency')

    // Recarregar fica na mesma aba.
    await page.reload()
    await expect(page).toHaveURL(/[?&]tab=delinquency\b/)
    await expect(consoleTabs(page).getByRole('button', { name: 'Inadimplência', exact: true }))
      .toHaveAttribute('aria-current', /page|true/)
    await expect(page.locator('table.modern-table').getByText(DELINQUENT_PROVIDER)).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeHidden()
  })

  test('Provedores → Plano: a troca pelo console com a prévia, desistida e depois agendada', async ({ page }) => {
    await consoleTabs(page).getByRole('button', { name: 'Provedores', exact: true }).click()
    const linha = page.getByRole('row').filter({ hasText: RENEWING_PROVIDER })
    await linha.getByRole('button', { name: 'Plano', exact: true }).click()

    const seletor = page.getByRole('combobox', { name: 'Plano', exact: true })
    await expect(seletor).toBeVisible()
    await expect(seletor.locator('option:checked')).toHaveText(/Essencial/)
    const aplicar = page.getByRole('button', { name: 'Aplicar troca' })

    // Outro plano: a prévia aparece, com os modos.
    await seletor.selectOption({ label: (await seletor.locator('option', { hasText: 'Profissional' }).textContent())!.trim() })
    const quando = page.getByRole('group', { name: 'Quando aplicar' })
    await expect(quando).toBeVisible()
    await expect(page.getByText('Vale agora.')).toBeVisible()
    await expect(page.getByText(/de pró-rata|pró-rata/).first()).toBeVisible()
    await shot(page, 'console-13-plan-change-preview')

    // Na renovação: a prévia muda para a data da renovação.
    await quando.getByRole('radio', { name: 'Na renovação' }).check()
    await expect(page.getByText(/^Vale na renovação, em /)).toBeVisible()
    await expect(aplicar).toBeEnabled()
    await shot(page, 'console-14-plan-change-renewal')

    // Desistir: voltar ao plano atual, e não há o que aplicar.
    await seletor.selectOption({ label: (await seletor.locator('option', { hasText: 'Essencial' }).textContent())!.trim() })
    await expect(page.getByText('Este já é o plano e o ciclo atuais.')).toBeVisible()
    await expect(aplicar).toBeDisabled()

    // Agora de verdade, na Delta (cobrada por fora, sem gateway): agendada
    // para a renovação, sem fatura nenhuma.
    await seletor.selectOption({ label: (await seletor.locator('option', { hasText: 'Profissional' }).textContent())!.trim() })
    await quando.getByRole('radio', { name: 'Na renovação' }).check()
    await aplicar.click()
    await expect(page.getByText(/Troca agendada para /).first()).toBeVisible()
    await shot(page, 'console-15-plan-change-scheduled')
  })

  test('Configurações → Régua de cobrança: a padrão, um passo novo com prévia, salvar e restaurar', async ({ page }) => {
    await consoleTabs(page).getByRole('button', { name: 'Configurações', exact: true }).click()
    await page.getByRole('navigation', { name: 'Configurações' }).getByRole('button', { name: 'Régua de cobrança' }).click()
    await expect(page.getByRole('heading', { name: 'Régua de cobrança' })).toBeVisible()

    // A padrão: três passos, com os ids travados (já salvos).
    const passos = page.locator('form ol > li')
    await expect(passos).toHaveCount(3)
    const ids = page.getByLabel('Identificador')
    await expect(ids.nth(0)).toHaveValue('before')
    await expect(ids.nth(1)).toHaveValue('due')
    await expect(ids.nth(2)).toHaveValue('after')
    await expect(ids.nth(0)).toHaveAttribute('readonly', '')
    await expect(page.getByTestId('reminders-restore-warning')).toBeVisible()
    await shot(page, 'console-16-reminders-default')

    // Um passo novo: id automático, editável até salvar; texto com prévia.
    await page.getByRole('button', { name: 'Adicionar passo' }).click()
    await expect(passos).toHaveCount(4)
    const novo = passos.nth(3)
    const idNovo = novo.getByLabel('Identificador')
    await expect(idNovo).toHaveValue(/^p[0-9a-z]+$/)
    await expect(idNovo).not.toHaveAttribute('readonly', '')
    await idNovo.fill('d7')
    await novo.getByLabel('Dias').fill('7')
    await novo.getByLabel('Assunto').fill('Ainda em aberto: {empresa}')
    await novo.getByLabel('Mensagem').fill('Olá, {empresa}! A fatura de {valor} segue em aberto: {link}')
    await expect(novo.getByText('Ainda em aberto: Provedor Exemplo')).toBeVisible()
    await expect(novo.getByText('Olá, Provedor Exemplo! A fatura de R$ 199,90 segue em aberto: https://painel.exemplo.com/fatura')).toBeVisible()
    await expect(page.getByText('Há alterações não salvas.')).toBeVisible()
    await shot(page, 'console-17-reminders-new-step')

    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await expect(page.getByText('Régua de cobrança salva').first()).toBeVisible()
    await expect(page.getByText('Há alterações não salvas.')).toBeHidden()
    // Salvo: o id do passo novo trava também.
    const salvo = passos.filter({ has: page.locator('input[value="d7"]') })
    await expect(salvo.getByLabel('Identificador')).toHaveAttribute('readonly', '')
    await shot(page, 'console-18-reminders-saved')

    // Restaurar a padrão e salvar.
    await page.getByRole('button', { name: 'Restaurar padrão' }).click()
    await expect(passos).toHaveCount(3)
    await expect(page.getByText('Há alterações não salvas.')).toBeVisible()
    await page.getByRole('button', { name: 'Salvar', exact: true }).click()
    await expect(page.getByText('Régua de cobrança salva').first()).toBeVisible()
    await expect(page.getByText('Há alterações não salvas.')).toBeHidden()
    await expect(passos).toHaveCount(3)
    await shot(page, 'console-19-reminders-restored')
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
  test('Planos → Agendar reajuste: a prévia, o agendamento, a edição direta barrada e o cancelamento', async ({ page }) => {
    await consoleTabs(page).getByRole('button', { name: 'Planos', exact: true }).click()
    const cartao = page.locator('div.rounded-md.border.p-3').filter({
      has: page.locator('code', { hasText: /^demo-profissional$/ })
    })
    await expect(cartao).toBeVisible()
    await cartao.getByRole('button', { name: 'Agendar reajuste' }).click()

    const painel = cartao.getByRole('region', { name: 'Agendar reajuste de preço' })
    await expect(painel).toBeVisible()
    await expect(painel.getByText(/Preço de hoje: R\$\s399,00/)).toBeVisible()
    await painel.getByLabel('Preço novo').fill('449,00')
    await painel.getByLabel('Motivo (opcional)').fill('IPCA (teste no navegador)')
    await painel.getByRole('button', { name: 'Ver prévia' }).click()
    const previa = painel.getByRole('status')
    await expect(previa).toContainText('passam a pagar o preço novo')
    await expect(previa).toContainText(/Receita por ciclo: .+ → .+ \(\+/)
    await shot(page, 'console-20-price-change-preview')

    await painel.getByRole('button', { name: 'Agendar', exact: true }).click()
    await expect(page.getByText('Reajuste agendado.').first()).toBeVisible()
    const selo = cartao.getByText(/Reajuste Mensal: R\$\s399,00 → R\$\s449,00 em \d{2}\/\d{2}\/\d{4}/)
    await expect(selo).toBeVisible()
    await expect(cartao.getByText('IPCA (teste no navegador)')).toBeVisible()
    await shot(page, 'console-21-price-change-scheduled')

    // Com o reajuste agendado, o preço mensal não muda à mão: a tela diz por
    // quê e aponta o "Cancelar reajuste", sem mandar nada.
    await cartao.getByRole('button', { name: 'Editar', exact: true }).click()
    await page.locator('#plan-price').fill('459,00')
    await cartao.getByRole('button', { name: 'Salvar', exact: true }).click()
    await expect(page.getByText(/Há um reajuste agendado para o preço \(mensal\) deste plano em/).first()).toBeVisible()
    // O aviso entra com uma animação: a captura espera ela terminar.
    await page.waitForTimeout(600)
    await shot(page, 'console-22-price-change-direct-edit-blocked', { fullPage: false })
    await cartao.getByRole('button', { name: 'Cancelar', exact: true }).first().click()

    // Cancelar pede confirmação, e o selo some.
    page.once('dialog', (dialog) => {
      expect(dialog.message()).toContain('Cancelar o reajuste para')
      void dialog.accept()
    })
    await cartao.getByRole('button', { name: 'Cancelar reajuste' }).click()
    await expect(page.getByText('Reajuste cancelado.').first()).toBeVisible()
    await expect(selo).toBeHidden()
    await cartao.getByText('Reajustes anteriores').click()
    await expect(cartao.getByText(/\(cancelado\)/)).toBeVisible()
    await shot(page, 'console-23-price-change-canceled')
  })

  test('Receita → Exportar para contabilidade baixa o XLSX', async ({ page }) => {
    await consoleTabs(page).getByRole('button', { name: 'Receita', exact: true }).click()
    const cartao = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Exportar para contabilidade' })
    })
    await expect(cartao).toBeVisible()
    await expect(cartao.getByLabel('Formato')).toHaveValue('xlsx')

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      cartao.getByRole('button', { name: 'Exportar para contabilidade' }).click()
    ])
    expect(download.suggestedFilename()).toMatch(/\.xlsx$/)
    const arquivo = await download.path()
    expect(arquivo).toBeTruthy()
    const tamanho = fs.statSync(arquivo!).size
    expect(tamanho).toBeGreaterThan(0)
    // Um XLSX é um zip: começa com "PK".
    expect(fs.readFileSync(arquivo!).subarray(0, 2).toString('latin1')).toBe('PK')
    await cartao.scrollIntoViewIfNeeded()
    await shot(page, 'console-24-accounting-export', { fullPage: false })
  })

  test('Receita → Satisfação: o NPS, a distribuição, os detratores e os comentários do seed', async ({ page }) => {
    await consoleTabs(page).getByRole('button', { name: 'Receita', exact: true }).click()
    const secao = page.locator('section[aria-labelledby="satisfaction-title"]')
    await expect(secao.getByRole('heading', { name: 'Satisfação dos provedores (NPS)' })).toBeVisible()
    await expect(secao.getByText('Promotores', { exact: true })).toBeVisible()
    await expect(secao.getByText('Distribuição das notas')).toBeVisible()
    // A Beta (nota 4, vencida) entre os detratores, e os comentários do seed.
    await expect(secao.getByText(DELINQUENT_PROVIDER).first()).toBeVisible()
    await expect(secao.getByText(/o boleto chegou tarde/).first()).toBeVisible()
    await expect(secao.getByText(/a troca de plano foi simples/)).toBeVisible()
    await secao.scrollIntoViewIfNeeded()
    await page.waitForLoadState('networkidle')
    await secao.screenshot({ path: `${SCREENSHOTS_DIR}/console-25-satisfaction.png` })
  })
})
