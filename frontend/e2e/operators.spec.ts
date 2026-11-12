import { expect, test } from '@playwright/test'
import { PROVIDER, loginViaForm, shot } from './support/demo'

/**
 * "Editar" um operador (Configurações → Acesso da conta → Operadores): o
 * cadastro completo — nome, CPF, contato, endereço, trabalho — gravado pela
 * API e lido de volta pela tela. O CPF volta inteiro só aqui, ao editar; a
 * lista mostra o nome completo e o cargo.
 */
test.describe('o cadastro do operador', () => {
  test('edita o próprio cadastro, recusa CPF inválido e lê de volta', async ({ page }) => {
    await loginViaForm(page, PROVIDER)
    await page.goto('/settings?tab=security')

    await page.getByRole('button', { name: /^Editar cadastro de / }).first().click()
    const dialogo = page.getByTestId('operator-edit')
    await expect(dialogo.getByRole('heading', { name: /^Cadastro de / })).toBeVisible()

    // Salvar fica desligado até algo mudar.
    const salvar = dialogo.getByRole('button', { name: 'Salvar' })
    await expect(salvar).toBeDisabled()

    // O próprio login não se troca por aqui.
    await expect(dialogo.getByLabel('Usuário')).toBeDisabled()

    await dialogo.getByLabel('Nome completo').fill('Dono da Alfa Fibra')
    await dialogo.getByLabel('Cargo / função').fill('Diretor')
    await dialogo.getByLabel('CPF').fill('11111111111')
    await expect(dialogo.getByLabel('CPF')).toHaveValue('111.111.111-11')
    await salvar.click()
    // CPF inválido: o diálogo continua aberto e o campo é marcado.
    await expect(dialogo.getByLabel('CPF')).toHaveAttribute('aria-invalid', 'true')

    await dialogo.getByLabel('CPF').fill('52998224725')
    await dialogo.getByLabel('Telefone', { exact: true }).fill('91988887777')
    await expect(dialogo.getByLabel('Telefone', { exact: true })).toHaveValue('(91) 98888-7777')
    await shot(page, 'operators-01-edit', { fullPage: false })
    await salvar.click()
    await expect(dialogo).toBeHidden()

    // A lista mostra nome e cargo; o cadastro está completo só com o que faltar.
    await expect(page.getByText('Dono da Alfa Fibra · Diretor').filter({ visible: true }).first()).toBeVisible()

    // E o CPF volta inteiro ao reabrir.
    await page.getByRole('button', { name: /^Editar cadastro de / }).first().click()
    await expect(page.getByTestId('operator-edit').getByLabel('CPF')).toHaveValue('529.982.247-25')
  })
})
