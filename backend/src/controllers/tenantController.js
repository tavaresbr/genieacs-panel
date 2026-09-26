import Tenant from '../models/Tenant.js';
import TenantUser from '../models/TenantUser.js';
import User from '../models/User.js';
import { normalizeRole } from '../config/permissions.js';
import { createResponse, createErrorResponse, isValidEmail } from '../utils/helpers.js';
import TenantExportService from '../services/tenantExportService.js';
import AuditLog from '../models/AuditLog.js';
import SubscriptionService from '../services/subscriptionService.js';
import BillingCharge from '../models/BillingCharge.js';
import DeviceService from '../services/deviceService.js';
import { EDITION } from '../config/edition.js';
import { panelBaseDomain, usesTenantSubdomains } from '../middleware/tenantResolver.js';
import { normalizeTaxId, isValidTaxId, isValidCnpj } from '../utils/taxId.js';
import { lookupCnpj } from '../services/cnpjLookupService.js';
import { lookupCep, geocodeAddress } from '../services/addressLookupService.js';

/**
 * O cadastro fiscal vindo do corpo, normalizado — ou o motivo de recusa.
 *
 * Recebe camelCase da tela e devolve as colunas do banco. Campo ausente não é
 * tocado; campo presente e vazio vira nulo, que é como se apaga o que foi
 * preenchido por engano. Essa diferença é o contrato inteiro desta função, e é
 * por isso que ela não monta um objeto completo com defaults.
 *
 * O CNPJ (ou CPF, do MEI) é o único campo conferido além do tamanho, e é por
 * onde a nota fiscal falha: um dígito trocado só aparece no dia da emissão,
 * quando quem conserta já é o financeiro e não quem digitou.
 */
const CAMPOS_FATURAMENTO = [
  ['legalName', 'billing_legal_name', 160],
  ['taxId', 'billing_tax_id', 20],
  ['stateRegistration', 'billing_state_registration', 32],
  ['postalCode', 'billing_postal_code', 8],
  ['addressLine', 'billing_address_line', 160],
  ['addressNumber', 'billing_address_number', 16],
  ['addressExtra', 'billing_address_extra', 80],
  ['district', 'billing_district', 80],
  ['city', 'billing_city', 80],
  ['state', 'billing_state', 2],
  ['email', 'billing_email', 160],
  ['phone', 'billing_phone', 32]
];

function billingPatch(entrada) {
  if (typeof entrada !== 'object' || Array.isArray(entrada)) {
    return { error: 'tenant.billingInvalid' };
  }
  const patch = {};
  for (const [chave, coluna, limite] of CAMPOS_FATURAMENTO) {
    if (!(chave in entrada)) continue;
    const bruto = entrada[chave];
    if (bruto === null || bruto === undefined || String(bruto).trim() === '') {
      patch[coluna] = null;
      continue;
    }
    let valor = String(bruto).trim();

    // Os três que o banco guarda sem enfeite, porque é assim que se comparam.
    if (coluna === 'billing_tax_id' || coluna === 'billing_postal_code') {
      valor = normalizeTaxId(valor);
    }
    if (coluna === 'billing_state') valor = valor.toUpperCase();

    if (valor.length > limite) return { error: 'tenant.billingInvalid' };
    if (coluna === 'billing_tax_id' && !isValidTaxId(valor)) {
      return { error: 'tenant.billingTaxIdInvalid' };
    }
    if (coluna === 'billing_postal_code' && valor.length !== 8) {
      return { error: 'tenant.billingPostalCodeInvalid' };
    }
    if (coluna === 'billing_state' && !/^[A-Z]{2}$/.test(valor)) {
      return { error: 'tenant.billingInvalid' };
    }
    if (coluna === 'billing_email' && !isValidEmail(valor)) {
      return { error: 'tenant.billingEmailInvalid' };
    }
    patch[coluna] = valor;
  }
  return { patch };
}

/**
 * What a provider will admit to before anybody has signed in.
 *
 * The login screen has to render the provider's own name, and it has to do so
 * with no token — so this is the one route that answers a stranger with
 * something drawn from the `tenants` row. That makes it the enumeration surface
 * of the whole deployment, and everything below is written against that.
 */
const NAME_MAX_LENGTH = 128;

/** Quem liga e desliga a exigência do 2FA: o `owner`, ou o `admin` onde não há `owner`. */
async function governaSeguranca(tenantId, role) {
  const papel = normalizeRole(role);
  if (papel === 'owner') return true;
  if (papel !== 'admin') return false;
  return (await TenantUser.countByRole(tenantId, 'owner')) === 0;
}

class TenantController {
  /**
   * `PATCH /api/tenant` — the provider renames itself.
   *
   * This is what `settings.appName` used to be: the name on the sidebar, the
   * login screen and the browser tab. It moves onto the `tenants` row because
   * that row is the provider — the console lists it, the public profile
   * answers it, and a name kept in two places was a name shown differently on
   * two screens. Audited on the provider's own trail: renaming is not
   * sensitive, but it is the kind of change somebody asks "who did that" about.
   */
  /**
   * Os dados públicos de um CNPJ, para preencher o cadastro — sem gravar.
   *
   * 400 para o número que nem é um CNPJ (não vale gastar a consulta), 404
   * quando a Receita não o conhece e 502 quando a consulta falhou; em
   * nenhum dos casos o cadastro deixa de poder ser digitado à mão.
   */
  static async lookupCnpj(req, res) {
    const cnpj = normalizeTaxId(req.query?.cnpj);
    if (!isValidCnpj(cnpj)) {
      return res.status(400).json(createErrorResponse(req.t('tenant.billingTaxIdInvalid')));
    }
    try {
      const result = await lookupCnpj(cnpj);
      if (!result.found) {
        return res.status(404).json(createErrorResponse(req.t('tenant.cnpjNotFound')));
      }
      return res.json(createResponse(req.t('tenant.cnpjFound'), { taxId: cnpj, ...result.data }));
    } catch (error) {
      return res.status(502).json(createErrorResponse(req.t('tenant.cnpjLookupFailed'), error.message));
    }
  }

  /**
   * `GET /api/tenant/security` — se o provedor exige o 2FA da equipe, e
   * quantas pessoas da equipe ainda não o ativaram (o que o dono quer saber
   * antes de ligar a exigência, e depois, para cobrar quem falta).
   */
  static async getSecurity(req, res) {
    try {
      const [requireMfa, equipe] = await Promise.all([
        Tenant.requiresMfa(req.tenantId),
        TenantUser.listForTenant(req.tenantId)
      ]);
      return res.json(createResponse(null, {
        requireMfa,
        membersWithoutMfa: equipe.filter((membro) => !membro.totp_enabled_at).length,
        // Se quem pergunta pode mudar — a tela mostra a chave ou só o estado.
        canChange: await governaSeguranca(req.tenantId, req.user.role)
      }));
    } catch (error) {
      console.error('Tenant security error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * `PUT /api/tenant/security` — o dono liga ou desliga a exigência do 2FA.
   *
   * "O dono" é o `owner` — e, num provedor sem nenhum `owner`, o `admin`. O
   * `/setup` de uma instalação nova cria o primeiro operador como `admin` (só
   * as instalações anteriores à 0030 e o cadastro da edição SaaS têm um
   * `owner`), e sem essa segunda metade ninguém ali conseguiria ligar a
   * exigência.
   *
   * Só o `owner`, conferido aqui como em `usersController` (`users.ownerOnly`):
   * `settings.write` é também do `admin`, e é justamente de quem administra que
   * o dono pode querer exigir o segundo fator.
   *
   * Ligar exige que o próprio dono já use o 2FA — senão o primeiro clique o
   * trancaria na tela de ativação no meio do que estava fazendo.
   */
  static async updateSecurity(req, res) {
    try {
      const pedido = req.body?.requireMfa;
      if (typeof pedido !== 'boolean') {
        return res.status(400).json(createErrorResponse(req.t('tenant.securityInvalid')));
      }
      if (!(await governaSeguranca(req.tenantId, req.user.role))) {
        return res.status(403).json(createErrorResponse(req.t('users.ownerOnly')));
      }
      if (pedido) {
        const eu = await User.findById(req.user.userId);
        if (!eu?.totp_enabled_at) {
          return res.status(409).json(
            createErrorResponse(req.t('tenant.mfaEnableYourselfFirst'), null, 'mfa_enable_yourself_first')
          );
        }
      }
      const antes = await Tenant.requiresMfa(req.tenantId);
      if (antes !== pedido) {
        await Tenant.setRequireMfa(req.tenantId, pedido);
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.TENANT_MFA_REQUIRED_CHANGED,
          subjectType: 'tenant',
          subjectId: req.tenantId,
          detail: { from: antes, to: pedido }
        });
      }
      return res.json(createResponse(req.t('tenant.securityUpdated'), { requireMfa: pedido }));
    } catch (error) {
      console.error('Tenant security update error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /** O endereço de um CEP, para preencher o cadastro — sem gravar. */
  static async lookupCep(req, res) {
    const cep = String(req.query?.cep ?? '').replace(/\D/g, '');
    if (cep.length !== 8) {
      return res.status(400).json(createErrorResponse(req.t('tenant.cepInvalid')));
    }
    try {
      const result = await lookupCep(cep);
      if (!result.found) {
        return res.status(404).json(createErrorResponse(req.t('tenant.cepNotFound')));
      }
      return res.json(createResponse(req.t('tenant.cepFound'), result.data));
    } catch (error) {
      return res.status(502).json(createErrorResponse(req.t('tenant.cepLookupFailed'), error.message));
    }
  }

  /**
   * O ponto no mapa de um endereço, para posicionar a sede — sem gravar.
   * Cidade e UF são o mínimo: sem elas, não há onde procurar.
   */
  static async geocode(req, res) {
    const campos = {};
    for (const chave of ['addressLine', 'addressNumber', 'district', 'city', 'state', 'postalCode']) {
      campos[chave] = String(req.query?.[chave] ?? '').slice(0, 160);
    }
    if (!campos.city.trim() || !campos.state.trim()) {
      return res.status(400).json(createErrorResponse(req.t('tenant.geocodeNeedsCity')));
    }
    try {
      const result = await geocodeAddress(campos);
      if (!result.found) {
        return res.status(404).json(createErrorResponse(req.t('tenant.geocodeNotFound')));
      }
      return res.json(createResponse(req.t('tenant.geocodeFound'), result.data));
    } catch (error) {
      return res.status(502).json(createErrorResponse(req.t('tenant.geocodeFailed'), error.message));
    }
  }

  static async rename(req, res) {
    try {
      const temNome = req.body?.name !== undefined;
      const temFaturamento = req.body?.billing !== undefined && req.body.billing !== null;
      if (!temNome && !temFaturamento) {
        return res.status(400).json(createErrorResponse(req.t('tenant.nameInvalid')));
      }

      const name = String(req.body?.name ?? '').trim();
      if (temNome && (name.length < 1 || name.length > NAME_MAX_LENGTH)) {
        return res.status(400).json(createErrorResponse(req.t('tenant.nameInvalid')));
      }

      let faturamento = null;
      if (temFaturamento) {
        const analise = billingPatch(req.body.billing);
        if (analise.error) {
          return res.status(400).json(createErrorResponse(req.t(analise.error)));
        }
        faturamento = analise.patch;
      }

      const before = await Tenant.findById(req.tenantId);
      if (!before) {
        return res.status(404).json(createErrorResponse(req.t('common.notFound')));
      }

      if (temNome) {
        await Tenant.rename(req.tenantId, name);
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.TENANT_RENAMED,
          subjectType: 'tenant',
          subjectId: req.tenantId,
          detail: { from: before.name, to: name }
        });
      }

      if (faturamento && Object.keys(faturamento).length) {
        await Tenant.updateBilling(req.tenantId, faturamento);
        // Os campos, nunca os valores. A trilha existe para responder "quem
        // mexeu no meu cadastro fiscal", e para isso o nome do campo basta —
        // repetir o CNPJ e o endereço em cada linha faria da trilha uma
        // segunda cópia do cadastro, com retenção maior que a dele.
        await AuditLog.fromRequest(req, {
          action: AuditLog.ACTIONS.TENANT_BILLING_CHANGED,
          subjectType: 'tenant',
          subjectId: req.tenantId,
          detail: { fields: Object.keys(faturamento).sort() }
        });
      }

      const depois = await Tenant.findById(req.tenantId);
      return res.json(createResponse(req.t('tenant.renamed'), {
        name: depois?.name ?? before.name,
        slug: before.slug,
        billing: Tenant.presentBilling(depois)
      }));
    } catch (error) {
      console.error('Rename tenant error:', error);
      return res.status(500).json(createErrorResponse(req.t('tenant.renameFailed'), error.message));
    }
  }

  /**
   * `GET /api/tenant/subscription`: o plano, o estado e o uso — a tela de
   * "plano e uso" do provedor, e a placa que a tela de bloqueio lê.
   *
   * A contagem de ONTs vem do GenieACS e pode falhar; ela vira `null` sem
   * derrubar o resto (ver `SubscriptionService.usage`). Sem preço: o preço é
   * do console.
   */
  static async getSubscription(req, res) {
    try {
      const usage = await SubscriptionService.usage({
        countDevices: () => DeviceService.countDevicesFromGenieAcs()
      });
      // O cadastro fiscal viaja aqui e não numa rota própria porque é a mesma
      // tela: "plano e uso" é onde o provedor olha a parte comercial dele, e
      // uma porta a mais no inventário custa mais do que quatro campos a mais
      // num corpo que esta tela já busca.
      const provedor = await Tenant.findById(req.tenantId);
      return res.json(createResponse(req.t('subscription.retrieved'), {
        ...usage,
        billing: Tenant.presentBilling(provedor)
      }));
    } catch (error) {
      console.error('Get subscription error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('subscription.retrieveFailed'), error.message)
      );
    }
  }

  /**
   * `GET /api/tenant/charges`: as cobranças que o painel emitiu a este
   * provedor — de que período, quanto, até quando, e onde se paga.
   *
   * A tabela existe desde a emissão automática e guarda `invoice_url`, a
   * página do gateway onde se paga. Até aqui esse endereço só saía pelo e-mail
   * de aviso (`subscriptionNoticeService`): quem perdeu o e-mail via o muro do
   * 402 e não tinha, em tela nenhuma, onde pagar.
   *
   * `settings.read`, a mesma de `/subscription`: quem pode ver em que plano o
   * provedor está pode ver o que foi cobrado por ele. E, como aquela, fica
   * FORA da porta da assinatura — ver o comentário em `subscriptionGate.js`.
   */
  static async listCharges(req, res) {
    try {
      const cobrancas = await BillingCharge.listRecent({ limit: 24 });
      return res.json(createResponse(req.t('charges.retrieved'), {
        charges: cobrancas.map((linha) => BillingCharge.present(linha))
      }));
    } catch (error) {
      console.error('List charges error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('charges.retrieveFailed'), error.message)
      );
    }
  }

  /**
   * O cadastro inteiro deste provedor, num arquivo.
   *
   * `Content-Disposition: attachment` com o slug e a data no nome: o arquivo
   * costuma ir para um e-mail ou um chamado, e um `export.json` sem dono vira
   * três arquivos iguais na pasta de quem recebeu.
   *
   * Auditado, e é uma das ações mais sensíveis que existem aqui — devolve todo
   * o cadastro de assinantes de uma vez. Sem registro, um operador de saída
   * baixaria a base inteira e nada no painel diria que isso aconteceu.
   */
  static async exportTenant(req, res) {
    try {
      const arquivo = await TenantExportService.build();
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TENANT_EXPORTED,
        subjectType: 'tenant',
        subjectId: arquivo.manifest.tenant?.id ?? null,
        detail: { rowCounts: arquivo.manifest.rowCounts }
      });

      const nome = [
        'skygenpanel',
        arquivo.manifest.tenant?.slug || 'export',
        new Date().toISOString().slice(0, 10)
      ].join('-');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nome}.json"`);
      return res.send(JSON.stringify(arquivo, null, 2));
    } catch (error) {
      console.error('Tenant export error:', error);
      return res.status(500).json(createErrorResponse(req.t('tenant.exportFailed'), error.message));
    }
  }

  /**
   * `GET /api/tenant/public`.
   *
   * There is no lookup here, and that is the design. The provider is whatever
   * `resolveTenant` already put on the request from the `Host` header; this
   * route accepts no slug, no id and no query of its own. A route that took the
   * provider from the caller would let anyone read any provider's row by asking
   * for it, which is precisely the hole the host-based resolver exists to close
   * — and it would close it nowhere else, because every other route would still
   * be scoped by host.
   *
   * The corollary is that an unknown host never gets this far: the resolver
   * answers 404 ahead of the routes, and so does a host naming a provider that
   * is not active, with the same body. Those two answers must stay identical,
   * because the difference between them is "this ISP is our customer and is
   * behind on its bill" — a fact about somebody else's business that we would
   * be publishing. Nothing in this file may introduce a way to tell them apart:
   * no status in the payload, no distinct message, no distinct status code, and
   * no branch that only a real-but-suspended provider can reach.
   *
   * On rate limiting: `/api` is already behind `apiLimiter` in `app.js`, mounted
   * above the resolver, so this route arrives limited at 300/min per
   * provider-and-address without anything further here. A second limiter on
   * this path specifically would be theatre for the threat that actually
   * matters. Enumeration does not need THIS route — the resolver's 404 is
   * visible on every path under `/api`, so a prober sweeping slugs would just
   * ask `/api/auth/login` and read the same signal at the same cost. The
   * ceiling that would bite a sweep is an address-keyed one ahead of the
   * resolver, since `apiLimiter`'s key folds in the slug and so hands a
   * prober a fresh budget for every slug guessed. That belongs where the
   * resolver is mounted, protecting every route at once; bolting it on here
   * would slow nothing down and would read as if the problem were solved.
   */
  static async getPublicProfile(req, res) {
    try {
      // The platform's own host: no provider, but the two facts a stranger
      // needs — that this is a SaaS, and where a provider's panel would live.
      // The screen turns that into "sign up here".
      if (req.platformHost) {
        return res.json(createResponse(req.t('tenant.publicRetrieved'), {
          slug: null,
          name: null,
          edition: EDITION,
          panelBaseDomain: panelBaseDomain()
        }));
      }

      const tenant = await Tenant.findPublicById(req.tenantId);

      // The row the resolver blessed is gone — a provider deleted while the
      // process was up, since the resolver caches slug to id for the life of
      // the process. Answered as the resolver would have answered had it read
      // the table a moment later, deliberately reusing `common.notFound`, so
      // this narrow race cannot become a third distinguishable outcome.
      if (!tenant) {
        return res.status(404).json(createErrorResponse(req.t('common.notFound')));
      }

      // Spelled out field by field rather than spread from the row. The model
      // already selects only the public columns, and this is the second of the
      // two locks on the same door: adding a field to what a stranger sees now
      // takes an edit here AND an edit there, and trips the test that pins the
      // exact key set.
      //
      // `id` is absent on purpose. The screen has no use for it — it renders a
      // name — and it is the stable primary key of a `tenants` row. Handing it
      // to unauthenticated callers invites clients to start sending it back,
      // and a tenant id in a request body is the exact shape of parameter that
      // becomes an IDOR the day some future route trusts it over the host. The
      // caller already named the provider by connecting to its host; the id
      // tells them nothing more about who they reached and gives them a handle
      // we would rather they never held.
      //
      // `slug` is present, and it is not a disclosure: on a deployment with
      // subdomains it is the very string the caller typed to get here, and on
      // one without, it is `default` for every install there has ever been. It
      // earns its place by being the stable key the client can cache branding
      // under, and by letting the screen say which provider it thinks it is
      // talking to when a proxy has rewritten the host underneath it.
      // Two more facts a stranger may know, both about the DEPLOYMENT rather
      // than about this provider. `edition` decides whether the screen offers
      // signup and whether it shows the database switcher — the SaaS edition is
      // not a secret, it is the product; every subdomain already says so.
      // `panelBaseDomain` is what signup needs to promise an address, and it is
      // the string in the caller's own address bar.
      // A porta COMPARTILHADA não veste ninguém.
      //
      // Num SaaS sem domínio-base todos os provedores entram pelo mesmo
      // endereço, e o que o resolvedor devolve aqui é o PRIMEIRO da tabela, por
      // fallback — não o provedor de quem está olhando, porque ninguém olhou
      // ainda. Mandar o nome dele punha a marca de um ISP na porta de todos os
      // outros: a equipe do segundo provedor via o nome do primeiro ao digitar
      // a senha.
      //
      // Só o NOME cai. O `slug` continua indo, e essa distinção é o ponto: a
      // tela deduz "aqui é a plataforma" de `slug === null`, então anulá-lo
      // trocaria o painel de todo mundo pela casca do console. Sem nome, a tela
      // cai sozinha no nome do produto.
      const compartilhado = EDITION === 'saas'
        && !usesTenantSubdomains()
        && (await Tenant.count()) > 1;

      return res.json(createResponse(req.t('tenant.publicRetrieved'), {
        name: compartilhado ? null : tenant.name,
        slug: tenant.slug,
        // `provider` ou `platform`. A tela precisa dele por uma razão só: a
        // caixa interna da plataforma não gerencia equipamento nenhum, e sem
        // isto o portão de onboarding a empurra para configurar um GenieACS
        // que ela nunca vai ter. Ver a justificativa em `Tenant.PUBLIC_COLUMNS`
        // para por que um fato do deploy pode sair numa rota aberta.
        kind: tenant.kind ?? 'provider',
        shared: compartilhado,
        edition: EDITION,
        panelBaseDomain: panelBaseDomain()
      }));
    } catch (error) {
      console.error('Get public tenant profile error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('tenant.publicFailed'), error.message)
      );
    }
  }
}

export default TenantController;
