import Tenant from '../models/Tenant.js';
import PlatformAudit from '../models/PlatformAudit.js';
import { BILLING_WEBHOOK_PATH } from '../config/billingWebhookPath.js';
import { panelBaseDomain } from '../middleware/tenantResolver.js';
import {
  AsaasSettingsError,
  generateWebhookToken,
  readPublic,
  save
} from '../services/billing/asaasSettingsService.js';
import { AsaasError, createCustomer, testConnection } from '../services/billing/asaasClient.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * As integrações da PLATAFORMA com sistemas de fora — hoje, a conta dela no
 * Asaas.
 *
 * É a outra metade da cobrança automática. A emissão (`chargeIssuingService`)
 * e o webhook (`billingWebhookController`) já existiam, mas só andavam com duas
 * variáveis no `.env` do servidor, e a única forma de trocá-las era um terminal
 * e um reinício. Esta tela as põe onde está quem opera a cobrança.
 *
 * Três regras, e as três vêm do resto do console:
 *
 * 1. **Nenhum segredo sai.** A leitura diz se a chave e o token existem e DE
 *    ONDE vêm (`db` ou `env`), nunca o valor — o mesmo de `/deployment`. A
 *    única exceção é o token cunhado aqui, que sai uma vez, na resposta da
 *    cunhagem, porque é preciso colá-lo no painel do gateway.
 * 2. **Ausente mantém, vazio apaga.** Um formulário que reenvia tudo não pode
 *    apagar a chave só porque o campo de senha voltou em branco — e apagar a
 *    gravada devolve a palavra ao `.env`, se ele tiver o valor.
 * 3. **Toda mudança na trilha da plataforma, sem o valor.**
 */

/**
 * O endereço que se cola no painel do gateway como destino do webhook.
 *
 * Do domínio-base quando há um — o ápice, que é onde a rota atende sem
 * provedor nenhum na frente —, senão de `PUBLIC_BASE_URL`, e senão só o
 * caminho: a tela mostra o que sabe, e um caminho sem host ainda diz a quem
 * configura o que falta completar. Nunca do `Host` da requisição, pelo motivo
 * de sempre: o cabeçalho é de quem pede.
 */
export function billingWebhookUrl() {
  const base = panelBaseDomain();
  if (base) return `https://${base}${BILLING_WEBHOOK_PATH}`;
  const publico = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (publico) {
    try {
      const parsed = new URL(publico);
      if (['http:', 'https:'].includes(parsed.protocol)) return `${publico}${BILLING_WEBHOOK_PATH}`;
    } catch {
      // Um `PUBLIC_BASE_URL` que não é URL cai no caminho sozinho, abaixo.
    }
  }
  return BILLING_WEBHOOK_PATH;
}

async function presentAsaas() {
  return { ...(await readPublic()), webhookUrl: billingWebhookUrl() };
}

function settingsError(res, error) {
  return res.status(error.status || 400).json(createErrorResponse(error.message, null, error.code));
}

/** Só os dígitos. CPF e CNPJ chegam formatados do cadastro fiscal. */
const digitos = (valor) => String(valor ?? '').replace(/\D+/g, '');

/**
 * O cadastro fiscal do provedor, nos nomes do gateway.
 *
 * Só os campos preenchidos: o gateway trata `""` como "apague isto" em alguns
 * campos e como inválido em outros, e mandar só o que existe é a forma de não
 * precisar saber qual é qual.
 *
 * O telefone vai como celular quando tem cara de celular — onze dígitos, com o
 * nove na frente do número —, senão como fixo. O gateway manda o aviso de
 * cobrança por SMS só para `mobilePhone`, e um fixo nesse campo é recusado.
 */
export function customerPayloadFor(tenant) {
  const payload = {
    name: String(tenant.billing_legal_name || tenant.name || '').trim(),
    cpfCnpj: digitos(tenant.billing_tax_id),
    externalReference: `tenant:${tenant.id}`,
    // A plataforma manda os avisos dela (e-mail de vencimento com o link). Os
    // do gateway por cima seriam o mesmo recado duas vezes, com duas marcas.
    notificationDisabled: true
  };
  const opcional = (chave, valor) => {
    const texto = String(valor ?? '').trim();
    if (texto) payload[chave] = texto;
  };
  opcional('email', tenant.billing_email);
  const fone = digitos(tenant.billing_phone);
  if (fone) payload[/^\d{2}9\d{8}$/.test(fone) ? 'mobilePhone' : 'phone'] = fone;
  opcional('postalCode', digitos(tenant.billing_postal_code));
  opcional('address', tenant.billing_address_line);
  opcional('addressNumber', tenant.billing_address_number);
  opcional('complement', tenant.billing_address_extra);
  opcional('province', tenant.billing_district);
  return payload;
}

class PlatformIntegrationsController {
  /** `GET /api/platform/integrations/asaas` */
  static async getAsaas(req, res) {
    try {
      return res.json(createResponse('Asaas integration retrieved', await presentAsaas()));
    } catch (error) {
      console.error('Get Asaas integration error:', error);
      return res.status(500).json(createErrorResponse('Failed to read the Asaas integration', error.message));
    }
  }

  /** `PUT /api/platform/integrations/asaas` — `{ environment?, apiKey?, webhookToken? }` */
  static async updateAsaas(req, res) {
    try {
      const corpo = req.body ?? {};
      const { changed } = await save({
        environment: corpo.environment,
        apiKey: corpo.apiKey,
        webhookToken: corpo.webhookToken
      });
      const atual = await presentAsaas();

      const registrada = await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_INTEGRATION_CHANGED,
        detail: {
          integration: 'asaas',
          environment: atual.environment,
          apiKeyChanged: changed.apiKey,
          webhookTokenChanged: changed.webhookToken
        }
      });
      if (!registrada) console.warn('Asaas integration changed without a platform trail line');

      return res.json(createResponse('Asaas integration updated', atual));
    } catch (error) {
      if (error instanceof AsaasSettingsError) return settingsError(res, error);
      console.error('Update Asaas integration error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the Asaas integration', error.message));
    }
  }

  /**
   * `POST /api/platform/integrations/asaas/test`
   *
   * A recusa do gateway responde 200 com `ok: false`, e não um 4xx: a rota
   * funcionou — a pergunta era "a chave presta?", e "não" é uma resposta. O
   * 400 fica para quando não há chave nenhuma a testar.
   */
  static async testAsaas(req, res) {
    try {
      const atual = await readPublic();
      if (!atual.apiKeyConfigured) {
        return res.status(400).json(createErrorResponse(
          'The Asaas API key is not configured', null, 'not_configured'
        ));
      }
      try {
        const { accountName } = await testConnection();
        return res.json(createResponse('Asaas answered', {
          ok: true,
          ...(accountName ? { accountName } : {}),
          environment: atual.environment
        }));
      } catch (error) {
        if (!(error instanceof AsaasError)) throw error;
        return res.json(createResponse(error.message, { ok: false, environment: atual.environment }, error.code));
      }
    } catch (error) {
      console.error('Test Asaas integration error:', error);
      return res.status(500).json(createErrorResponse('Failed to test the Asaas integration', error.message));
    }
  }

  /**
   * `POST /api/platform/integrations/asaas/webhook-token`
   *
   * Cunha, grava e devolve — a única vez em que o token sai do servidor. Quem
   * cunhou cola no painel do gateway; quem perdeu cunha outro, e o velho para
   * de valer na hora, que é o que se quer de um token que alguém perdeu.
   */
  static async rotateWebhookToken(req, res) {
    try {
      const { webhookToken, settings } = await generateWebhookToken();
      const registrada = await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.PLATFORM_INTEGRATION_CHANGED,
        detail: {
          integration: 'asaas',
          environment: settings.environment,
          apiKeyChanged: false,
          webhookTokenChanged: true
        }
      });
      if (!registrada) console.warn('Asaas webhook token minted without a platform trail line');
      return res.json(createResponse('Webhook token generated', { webhookToken }));
    } catch (error) {
      if (error instanceof AsaasSettingsError) return settingsError(res, error);
      console.error('Generate Asaas webhook token error:', error);
      return res.status(500).json(createErrorResponse('Failed to generate the webhook token', error.message));
    }
  }

  /**
   * `POST /api/platform/tenants/:id/gateway/asaas-customer`
   *
   * Cria o provedor como cliente na conta Asaas da plataforma e o liga a ele —
   * o passo que antes era abrir o painel do gateway, cadastrar o CNPJ à mão e
   * colar o id de volta no console, com a chance de colar o id do cliente
   * errado e mandar o crédito de um para o outro.
   *
   * 409 quando já há vínculo: criar um segundo cliente para quem já tem um
   * deixaria dois cadastros no gateway para o mesmo CNPJ, e as cobranças de
   * um não achariam o outro. Para trocar, desliga-se primeiro, pelo PATCH.
   */
  static async createAsaasCustomer(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const tenant = await Tenant.findById(id);
      // A caixa da plataforma não é cliente de ninguém — ver a emissão.
      if (!tenant || tenant.kind === 'platform') {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }
      if (tenant.billing_customer_ref) {
        return res.status(409).json(createErrorResponse(
          'This provider is already linked to a gateway customer', null, 'already_linked'
        ));
      }

      const payload = customerPayloadFor(tenant);
      if (!payload.cpfCnpj) {
        return res.status(400).json(createErrorResponse(
          'The provider has no tax id (CPF/CNPJ) in its billing details', null, 'missing_tax_id'
        ));
      }
      if (payload.cpfCnpj.length !== 11 && payload.cpfCnpj.length !== 14) {
        return res.status(400).json(createErrorResponse(
          'The provider tax id must have 11 (CPF) or 14 (CNPJ) digits', null, 'invalid_tax_id'
        ));
      }
      if (!payload.name) {
        return res.status(400).json(createErrorResponse('The provider has no name', null, 'missing_name'));
      }

      let customerId;
      try {
        ({ customerId } = await createCustomer(payload));
      } catch (error) {
        if (!(error instanceof AsaasError)) throw error;
        // Sem chave é configuração deste lado; recusa do gateway é o cadastro
        // (um CNPJ que ele não aceita); o resto é o gateway ou a rede.
        const status = error.code === 'not_configured' ? 400 : error.code === 'refused' ? 422 : 502;
        return res.status(status).json(createErrorResponse(error.message, null, error.code));
      }

      // Relido antes de gravar: dois cliques quase juntos passariam os dois
      // pela conferência de cima. O segundo perde aqui, e o cliente que ele
      // criou no gateway fica no log — órfão, mas achável.
      const agora = await Tenant.findById(id);
      if (agora?.billing_customer_ref) {
        console.warn(`Provider ${id} got linked meanwhile; gateway customer ${customerId} is orphaned`);
        return res.status(409).json(createErrorResponse(
          'This provider is already linked to a gateway customer', null, 'already_linked'
        ));
      }
      await Tenant.updateGateway(id, { billing_gateway: 'asaas', billing_customer_ref: customerId });

      const registrada = await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_GATEWAY_CUSTOMER_CREATED,
        tenant,
        // O gateway e que houve vínculo; o id do cliente, não — mesma razão de
        // `setGateway`: é a chave que decide para quem vai o crédito.
        detail: { gateway: 'asaas', linked: true }
      });
      if (!registrada) console.warn(`Provider ${id} gateway customer created without a platform trail line`);

      const atual = await Tenant.findById(id);
      return res.status(201).json(createResponse('Gateway customer created', {
        id, gateway: Tenant.presentGateway(atual)
      }));
    } catch (error) {
      console.error('Create Asaas customer error:', error);
      return res.status(500).json(createErrorResponse('Failed to create the gateway customer', error.message));
    }
  }
}

export default PlatformIntegrationsController;
