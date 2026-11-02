import { expect, test } from '@playwright/test'
import { ADMIN_STATE, consoleTabs, shot } from './support/demo'

/**
 * A página de status (0127): o console abre um incidente, a página pública
 * `/status` o mostra em andamento, o console o resolve e ele vai para o
 * histórico.
 */
test.describe.configure({ mode: 'serial' })

const TITULO = 'Lentidão no painel (teste no navegador)'

test.describe('Status', () => {
  test.use({ storageState: ADMIN_STATE })

  test('abrir um incidente, vê-lo na página pública e resolver', async ({ page, context }) => {
    await page.goto('/platform')
    await consoleTabs(page).getByRole('button', { name: 'Status', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Página de status' })).toBeVisible()
    await page.waitForLoadState('networkidle')
    await shot(page, 'status-01-console')

    await page.getByRole('button', { name: 'Novo incidente' }).click()
    await page.getByLabel('Título').fill(TITULO)
    await page.getByRole('checkbox', { name: 'Painel' }).check()
    await page.getByLabel('Impacto').selectOption('minor')
    await page.getByLabel('Mensagem pública').fill('Investigando a lentidão ao abrir a lista de dispositivos.')
    const aviso = page.getByRole('checkbox', { name: /Avisar os provedores/ })
    if (await aviso.isChecked()) await aviso.uncheck()
    await shot(page, 'status-02-console-new-incident')
    await page.getByRole('button', { name: 'Publicar', exact: true }).click()
    await expect(page.getByText('Publicado na página de status.').first()).toBeVisible()
    const item = page.getByRole('listitem').filter({ hasText: TITULO })
    await expect(item).toBeVisible()

    // A página pública, sem sessão.
    // Sem sessão nenhuma (o `storageState` vazio, explícito: o do projeto
    // viria junto).
    const anonimo = await context.browser()!.newContext({ baseURL: process.env.E2E_BASE_URL, storageState: { cookies: [], origins: [] }, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' })
    const publica = await anonimo.newPage()
    await publica.goto('/status')
    await expect(publica.getByRole('heading', { name: 'Status dos serviços' })).toBeVisible()
    await expect(publica.getByRole('heading', { name: 'Incidentes em andamento' })).toBeVisible()
    await expect(publica.getByText(TITULO)).toBeVisible()
    await shot(publica, 'status-03-public-active')

    // Resolver, com a mensagem final.
    await item.getByLabel('Mensagem pública').fill('Corrigido: o índice da lista foi refeito.')
    await item.getByRole('button', { name: 'Resolver' }).click()
    await expect(item.getByText('Resolvido').first()).toBeVisible()
    await shot(page, 'status-04-console-resolved')

    await publica.reload()
    await expect(publica.getByRole('heading', { name: 'Histórico recente' })).toBeVisible()
    const historico = publica.locator('section, div').filter({ has: publica.getByRole('heading', { name: 'Histórico recente' }) }).last()
    await expect(historico.getByText(TITULO)).toBeVisible()
    await expect(publica.getByRole('heading', { name: 'Incidentes em andamento' })).toHaveCount(0)
    await shot(publica, 'status-05-public-resolved')
    await anonimo.close()
  })
})
