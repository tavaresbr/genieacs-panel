import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { PROVIDER, sessionFor, shot } from './support/demo'

/**
 * O cadastro guiado do número oficial, na tela de verdade: Configurações →
 * Integrações → WhatsApp → Números.
 *
 * O painel e o backend são os reais. O que é de mentira é o que está fora do
 * painel: a Meta (as duas rotas do servidor que falam com ela, `start` e
 * `complete`, e a página do popup em `tr69.com.br`, que aqui só devolve o
 * resultado por `postMessage` como a página de verdade faz). O que se prova: o
 * popup abre no clique, a resposta só vale vinda da origem certa e com o `state`
 * certo, o `complete` leva o que o formulário tinha, e o formulário manual
 * continua existindo.
 */

const SIGNUP_URL = 'https://tr69.com.br/whatsapp-signup.html'
const STATE = 'a'.repeat(64)
const WABA = '123456789012345'
const PHONE = '109876543210987'

type Received = { body: Record<string, unknown> }

const ok = (data: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify({ success: true, message: 'ok', data })
})

function account(over: Record<string, unknown> = {}) {
  return {
    id: 901, name: 'skygp_e2e_oficial', label: 'Atendimento', purpose: 'support', color: 'blue', flavor: 'v2',
    integration: 'cloud', metaPhoneNumberId: PHONE, metaWabaId: WABA, status: 'connected', baseUrl: 'https://evo.test',
    phoneE164: null, lastSeenAt: null, isDefault: false, metaOnboarding: 'embedded', metaCoexistence: false,
    metaSyncState: null, metaSyncError: null, metaCoexistenceDeadlineAt: null, metaWebhookStatus: 'ok',
    ...over
  }
}

/**
 * A página do popup. `reply` diz o que ela devolve ao painel; o `return` é o
 * que o painel pediu (a origem dele), e é para lá que ela posta — nunca `*`.
 */
async function fakeSignupPopup(context: BrowserContext, reply: (query: URLSearchParams) => Record<string, unknown> | null) {
  await context.route('https://tr69.com.br/**', (route) => {
    const query = new URL(route.request().url()).searchParams
    const payload = reply(query)
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><title>Meta</title><p>cadastro</p><script>
        const payload = ${JSON.stringify(payload)};
        const target = new URLSearchParams(location.search).get('return');
        if (payload) { window.opener.postMessage(payload, target); window.close(); }
      </script>`
    })
  })
}

/**
 * O provedor demo não tem o servidor Evolution configurado, e sem isso o botão
 * de conectar número fica desabilitado. A configuração é lida pronta (servidor
 * gerenciado pela plataforma, como na SaaS).
 */
async function mockReadyConfig(page: Page) {
  await page.route('**/api/whatsapp/config', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    return route.fulfill(ok({
      enabled: true, allowedHosts: [], webhookBaseUrl: 'https://painel.test/api/whatsapp-webhook',
      rejectCallMessage: '', portalPublicUrl: '', rateLimitPerMin: 60, bulkIntervalMinSec: 20, bulkIntervalMaxSec: 45,
      bulkBurstSize: 30, bulkBurstPauseMin: 5, managedUrl: 'https://evo.test', managed: true,
      managedAdminKeyConfigured: true, ready: true, updatedAt: null,
      cloudWebhook: { callbackUrl: '', verifyToken: '', auto: true }
    }))
  })
}

async function mockServer(page: Page, { available = true, received = [] as Received[], account: created = account() } = {}) {
  await mockReadyConfig(page)
  await page.route('**/api/whatsapp/accounts/embedded-signup/start', async (route) => {
    const { returnOrigin } = route.request().postDataJSON() as { returnOrigin: string }
    await route.fulfill(available
      ? ok({
        available: true, appId: '2151827142378177', configId: '1477066904263675', state: STATE,
        returnOrigin, signupUrl: SIGNUP_URL, expiresInSec: 600
      })
      : ok({ available: false }))
  })
  await page.route('**/api/whatsapp/accounts/embedded-signup/complete', async (route) => {
    received.push({ body: route.request().postDataJSON() as Record<string, unknown> })
    await route.fulfill(ok({ account: created, coexistence: Boolean(created.metaCoexistence), reused: false }, 201))
  })
  return received
}

async function openNumbers(page: Page) {
  await page.goto('/settings')
  // Integrações é uma grade de cartões: abre o do WhatsApp e depois a aba dos números.
  await page.getByRole('button', { name: /^WhatsApp\b/ }).click()
  await page.getByRole('tab', { name: 'Números' }).click()
  await page.getByRole('button', { name: 'Conectar um número' }).click()
  await page.getByRole('button', { name: /API oficial \(Meta\)/ }).click()
}

test.describe('cadastro guiado do número oficial', () => {
  test.use({ storageState: sessionFor(PROVIDER) })

  test('o clique abre o popup, a resposta cria o número e o formulário fecha', async ({ page, context }) => {
    const received = await mockServer(page)
    await fakeSignupPopup(context, (q) => ({
      type: 'wa-embedded-signup', state: q.get('state'), event: 'FINISH', code: 'cod-30s',
      wabaId: WABA, phoneNumberId: PHONE, businessId: '5550001'
    }))

    await openNumbers(page)
    const rotulo = page.locator('#wa-new-label')
    await rotulo.fill('Atendimento')
    // O guiado é o caminho principal: o formulário manual fica escondido.
    await expect(page.getByRole('button', { name: 'Conectar com a Meta' })).toBeVisible()
    await expect(page.locator('#wa-new-meta-token')).toBeHidden()
    await shot(page, 'whatsapp-guided-01-button')

    await page.getByRole('button', { name: 'Conectar com a Meta' }).click()

    await expect.poll(() => received.length).toBe(1)
    expect(received[0].body).toMatchObject({
      state: STATE, code: 'cod-30s', wabaId: WABA, phoneNumberId: PHONE, event: 'FINISH', label: 'Atendimento'
    })
    // O número entrou na lista e o formulário de adicionar fechou.
    await expect(page.getByText('Atendimento').first()).toBeVisible()
    await expect(page.getByRole('button', { name: 'Conectar com a Meta' })).toBeHidden()
    await shot(page, 'whatsapp-guided-02-connected')
  })

  test('coexistência: a caixa marca o popup e a conta mostra a sincronização e o prazo', async ({ page, context }) => {
    const prazo = new Date(Date.now() + 5 * 3_600_000).toISOString()
    const received = await mockServer(page, {
      account: account({ metaCoexistence: true, metaSyncState: 'error', metaSyncError: 'history: (80008) Throttled', metaCoexistenceDeadlineAt: prazo })
    })
    let modo: string | null = null
    await fakeSignupPopup(context, (q) => {
      modo = q.get('mode')
      return {
        type: 'wa-embedded-signup', state: q.get('state'), event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
        code: 'cod', wabaId: WABA, phoneNumberId: PHONE, businessId: null
      }
    })
    let tentativas = 0
    await page.route('**/api/whatsapp/accounts/901/coexistence-sync', async (route) => {
      tentativas += 1
      await route.fulfill(ok({
        account: account({ metaCoexistence: true, metaSyncState: 'ok', metaCoexistenceDeadlineAt: prazo })
      }))
    })

    await openNumbers(page)
    await page.getByLabel(/Já uso este número no app WhatsApp Business/).check()
    await page.getByRole('button', { name: 'Conectar com a Meta' }).click()

    await expect.poll(() => received.length).toBe(1)
    expect(modo).toBe('coexistence')
    expect(received[0].body.event).toBe('FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING')

    const sync = page.getByTestId('coexistence-sync')
    await expect(sync).toContainText('A sincronização falhou: history: (80008) Throttled')
    await expect(sync).toContainText('Faltam 5 h')
    await shot(page, 'whatsapp-guided-03-coexistence-error')

    await sync.getByRole('button', { name: 'Tentar de novo' }).click()
    await expect(sync).toContainText('Contatos e histórico sincronizados.')
    await expect(sync.getByRole('button', { name: 'Tentar de novo' })).toBeHidden()
    expect(tentativas).toBe(1)
  })

  test('resposta de outra origem ou com outro state é ignorada: nada é enviado ao servidor', async ({ page, context }) => {
    const received = await mockServer(page)
    // O popup devolve com um `state` que o painel não pediu.
    await fakeSignupPopup(context, () => ({
      type: 'wa-embedded-signup', state: 'b'.repeat(64), event: 'FINISH', code: 'cod',
      wabaId: WABA, phoneNumberId: PHONE, businessId: null
    }))

    await openNumbers(page)
    await page.getByRole('button', { name: 'Conectar com a Meta' }).click()
    // O popup fecha sozinho sem uma resposta válida: a tela entende como desistência.
    await expect(page.getByRole('alert')).toContainText('O cadastro foi cancelado', { timeout: 15_000 })
    expect(received).toHaveLength(0)
  })

  test('cancelar no popup mostra a frase e deixa tentar de novo', async ({ page, context }) => {
    const received = await mockServer(page)
    await fakeSignupPopup(context, (q) => ({
      type: 'wa-embedded-signup', state: q.get('state'), error: 'cancelled', event: 'CANCEL', step: 'PHONE_NUMBER_SETUP'
    }))

    await openNumbers(page)
    await page.getByRole('button', { name: 'Conectar com a Meta' }).click()
    await expect(page.getByRole('alert')).toContainText('O cadastro foi cancelado')
    await expect(page.getByRole('button', { name: 'Conectar com a Meta' })).toBeEnabled()
    expect(received).toHaveLength(0)
  })

  test('recusa do servidor (número de outro provedor) vira a frase certa, sem texto cru', async ({ page, context }) => {
    await mockServer(page)
    await page.route('**/api/whatsapp/accounts/embedded-signup/complete', (route) => route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, message: 'texto cru do servidor', code: 'meta_number_in_use' })
    }))
    await fakeSignupPopup(context, (q) => ({
      type: 'wa-embedded-signup', state: q.get('state'), event: 'FINISH', code: 'cod',
      wabaId: WABA, phoneNumberId: PHONE, businessId: null
    }))

    await openNumbers(page)
    await page.getByRole('button', { name: 'Conectar com a Meta' }).click()
    await expect(page.getByRole('alert')).toContainText('Este número já está conectado a outro provedor.')
    await expect(page.getByRole('alert')).not.toContainText('texto cru')
  })

  test('sem o app da Meta na plataforma, cai direto no formulário manual', async ({ page }) => {
    await mockServer(page, { available: false })
    await openNumbers(page)
    await expect(page.locator('#wa-new-meta-token')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Conectar com a Meta' })).toBeHidden()
    await shot(page, 'whatsapp-guided-04-manual-fallback')
  })

  test('com o guiado disponível, o formulário manual abre pelo link', async ({ page }) => {
    await mockServer(page)
    await openNumbers(page)
    await expect(page.locator('#wa-new-meta-token')).toBeHidden()
    await page.getByRole('button', { name: 'Prefiro colar o token e os IDs' }).click()
    await expect(page.locator('#wa-new-meta-token')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Esconder o formulário manual' })).toBeVisible()
  })
})
