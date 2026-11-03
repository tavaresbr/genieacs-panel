import Setting from '../models/Setting.js';
import GenieAcsConnection from '../models/GenieAcsConnection.js';
import Tenant from '../models/Tenant.js';
import TenantUser from '../models/TenantUser.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import ProvisioningProfile from '../models/ProvisioningProfile.js';
import DeviceService from './deviceService.js';
import SgpService from './sgpService.js';
import AsaasProviderService from './asaasProviderService.js';
import WaAlertService from './waAlertService.js';
import agentHub from './genieacs/agentHub.js';
import { runInTenant } from '../config/tenantContext.js';
import { timestampMs } from '../utils/helpers.js';

/** As duas marcas de "já vi isto", por provedor, na tabela `settings`. */
export const WIZARD_DONE_KEY = 'onboardingWizardDoneAt';
export const CHECKLIST_DISMISSED_KEY = 'onboardingChecklistDismissedAt';
/** A etapa do assistente em que o provedor parou, para retomar dali. */
export const WIZARD_STEP_KEY = 'onboardingWizardStep';
/**
 * Quando o primeiro equipamento foi visto no ACS. É um marco, não um estado:
 * uma vez visto, o modo leve (o do console) responde por ele sem perguntar ao
 * GenieACS, que é a única leitura lenta do checklist.
 */
export const FIRST_DEVICE_SEEN_KEY = 'onboardingFirstDeviceSeenAt';

/** As etapas do assistente, na ordem da tela. Só estas são gravadas. */
export const WIZARD_STEPS = Object.freeze([
  'welcome', 'identity', 'acs', 'sgp', 'asaas', 'whatsapp', 'billing', 'team', 'done'
]);

/** Quanto o painel espera o ACS responder antes de dar o item por pendente. */
const DEVICE_COUNT_TIMEOUT_MS = 4000;

/** Há quanto tempo o agente pode ter sido visto para contar como "no ar". */
export const AGENT_ONLINE_WINDOW_MS = 10 * 60 * 1000;

/**
 * A ordem é a da tela: do que destrava tudo ao que só refina. O primeiro
 * aplicável pendente é o "próximo passo".
 *
 * `whatsapp` (um número cadastrado) continua, com a mesma chave e o mesmo
 * sentido de antes; `whatsappConnected` é o passo seguinte — o número
 * pareado e conectado. Clientes que só conheciam os seis itens antigos
 * continuam achando todos eles, com o mesmo `{ key, done }`.
 */
export const ONBOARDING_ITEMS = [
  'genieacs', 'genieacsOnline', 'firstDevice', 'provisioning', 'sgp', 'asaas',
  'whatsapp', 'whatsappConnected', 'alerts', 'billingContact', 'team'
];

/** Para onde cada item leva no painel do provedor. */
export const ONBOARDING_HREFS = Object.freeze({
  genieacs: '/settings?tab=general',
  genieacsOnline: '/settings?tab=general',
  firstDevice: '/devices',
  provisioning: '/settings?tab=provisioning',
  sgp: '/settings?tab=sgp',
  asaas: '/settings?tab=asaas',
  whatsapp: '/settings?tab=whatsapp',
  whatsappConnected: '/settings?tab=whatsapp',
  alerts: '/whatsapp?tab=alerts',
  billingContact: '/settings?tab=provider',
  team: '/settings?tab=security'
});

/** O console: provedor "travado" é o que passou disto sem chegar à metade. */
export const STUCK_AFTER_DAYS = 7;
export const STUCK_BELOW_PERCENT = 50;
/** O resumo do console por provedor vale por isto. */
const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;
/** Quantos provedores o console confere ao mesmo tempo. */
const SUMMARY_CONCURRENCY = 4;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function filled(value) {
  return Boolean(String(value ?? '').trim());
}

/** Percentual dos itens aplicáveis feitos, inteiro. Sem nenhum aplicável: 100. */
export function percentOf(items) {
  const applicable = items.filter((item) => item.applicable);
  if (applicable.length === 0) return 100;
  return Math.round((applicable.filter((item) => item.done).length / applicable.length) * 100);
}

/**
 * Os primeiros passos de um provedor novo, conferidos no que ele TEM, e não
 * numa marca que alguém clicou: "SGP configurado" é o SGP ter endereço e token,
 * "primeiro equipamento" é o ACS devolver um. Assim o checklist não mente
 * depois de uma configuração desfeita, nem pede o que já foi feito por outra
 * tela.
 *
 * Uma fonte que falha — o ACS fora do ar, a leitura de uma tabela — vira
 * "pendente", nunca um erro: o checklist é um guia, e o Dashboard onde ele mora
 * não pode cair porque o GenieACS não respondeu.
 *
 * Um item que não se aplica a este provedor (o agente do GenieACS, quando a
 * conexão é direta) vem com `applicable: false` e fica fora do percentual e
 * do próximo passo.
 */
export default class OnboardingService {
  static summaryCache = new Map();

  /**
   * `light`: sem perguntar ao GenieACS. O primeiro equipamento sai do marco
   * gravado na última leitura completa. É o modo do console, que confere todos
   * os provedores de uma vez e não pode esperar um ACS por provedor.
   */
  static async status(tenantId, { light = false } = {}) {
    const genieAcsUrl = await Setting.getByKey('genieAcsUrl').catch(() => null);
    // No modo agente o endereço pode ficar vazio: quem sabe onde o GenieACS
    // está é o agente, na rede do provedor. Ter escolhido o modo é o passo.
    const modoAgente = (await GenieAcsConnection.mode().catch(() => 'direct')) === 'agent';
    const hasAcs = modoAgente || Boolean(String(genieAcsUrl || '').trim());
    const firstDeviceSeenAt = await Setting.getByKey(FIRST_DEVICE_SEEN_KEY).catch(() => null);

    const checks = {
      genieacs: async () => hasAcs,
      genieacsOnline: async () => {
        if (agentHub.isConnected(tenantId)) return true;
        const { lastSeenAt } = await GenieAcsConnection.agentInfo();
        const visto = timestampMs(lastSeenAt);
        return Number.isFinite(visto) && Date.now() - visto < AGENT_ONLINE_WINDOW_MS;
      },
      firstDevice: async () => {
        if (firstDeviceSeenAt) return true;
        if (light || !hasAcs) return false;
        const count = await withTimeout(DeviceService.countDevicesFromGenieAcs(null), DEVICE_COUNT_TIMEOUT_MS);
        if (count > 0) {
          await Setting.upsert(FIRST_DEVICE_SEEN_KEY, new Date().toISOString()).catch(() => {});
          return true;
        }
        return false;
      },
      provisioning: async () => (await ProvisioningProfile.countEnabled()) > 0,
      sgp: async () => {
        const config = await SgpService.getConfig();
        return Boolean(config.enabled && config.baseUrl && config.token);
      },
      asaas: async () => AsaasProviderService.isReady(await AsaasProviderService.getConfig()),
      whatsapp: async () => (await WhatsAppAccount.getAll()).length > 0,
      whatsappConnected: async () => (await WhatsAppAccount.getAll()).some((account) => account.status === 'connected'),
      alerts: async () => (await WaAlertService.getPublicSettings()).ready === true,
      billingContact: async () => {
        const tenant = await Tenant.findById(tenantId);
        return filled(tenant?.billing_email) || filled(tenant?.billing_phone);
      },
      team: async () => (await TenantUser.listForTenant(tenantId)).length > 1
    };
    const applicableOf = { genieacsOnline: modoAgente };

    const results = await Promise.allSettled(ONBOARDING_ITEMS.map((key) => checks[key]()));
    const items = ONBOARDING_ITEMS.map((key, index) => ({
      key,
      done: results[index].status === 'fulfilled' && results[index].value === true,
      applicable: applicableOf[key] ?? true,
      href: ONBOARDING_HREFS[key]
    }));

    const [wizardDoneAt, checklistDismissedAt, wizardStep] = await Promise.all([
      Setting.getByKey(WIZARD_DONE_KEY).catch(() => null),
      Setting.getByKey(CHECKLIST_DISMISSED_KEY).catch(() => null),
      Setting.getByKey(WIZARD_STEP_KEY).catch(() => null)
    ]);

    return {
      wizardDone: Boolean(wizardDoneAt),
      checklistDismissed: Boolean(checklistDismissedAt),
      wizardStep: WIZARD_STEPS.includes(wizardStep) ? wizardStep : null,
      items,
      percent: percentOf(items),
      nextStep: items.find((item) => item.applicable && !item.done)?.key ?? null
    };
  }

  /** `what` já validado pelo controller: 'wizard' ou 'checklist'. */
  static async dismiss(what) {
    const key = what === 'wizard' ? WIZARD_DONE_KEY : CHECKLIST_DISMISSED_KEY;
    await Setting.upsert(key, new Date().toISOString());
  }

  static isWizardStep(step) {
    return WIZARD_STEPS.includes(step);
  }

  /** Grava a etapa em que o assistente está. `step` já validado. */
  static async saveWizardStep(step) {
    await Setting.upsert(WIZARD_STEP_KEY, step);
  }

  /**
   * O resumo de UM provedor para o console: percentual, feitos e aplicáveis,
   * e se está travado. Lido no escopo dele, no modo leve, e guardado por
   * alguns minutos — o console relê a lista a cada clique.
   */
  static async summaryFor(tenant, { now = Date.now() } = {}) {
    const id = Number(tenant.id);
    const cached = this.summaryCache.get(id);
    if (cached && cached.expiresAt > now) return cached.value;

    const status = await runInTenant(id, () => this.status(id, { light: true }));
    const applicable = status.items.filter((item) => item.applicable);
    const created = timestampMs(tenant.created_at);
    const ageDays = Number.isFinite(created) ? (now - created) / 86400000 : 0;
    const value = {
      tenantId: id,
      percent: status.percent,
      done: applicable.filter((item) => item.done).length,
      total: applicable.length,
      nextStep: status.nextStep,
      stuck: ageDays >= STUCK_AFTER_DAYS && status.percent < STUCK_BELOW_PERCENT
    };
    this.summaryCache.set(id, { value, expiresAt: now + SUMMARY_CACHE_TTL_MS });
    return value;
  }

  /**
   * O resumo de vários provedores, no máximo `SUMMARY_CONCURRENCY` de cada vez.
   * Um provedor cuja leitura falhou fica de fora, em vez de derrubar a lista.
   */
  static async summaries(tenants) {
    const out = [];
    let next = 0;
    const worker = async () => {
      while (next < tenants.length) {
        const tenant = tenants[next];
        next += 1;
        try {
          // eslint-disable-next-line no-await-in-loop -- a concorrência é limitada de propósito
          out.push(await this.summaryFor(tenant));
        } catch (error) {
          console.warn(`[onboarding] provedor ${tenant.id}: resumo indisponível (${error?.message || error})`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SUMMARY_CONCURRENCY, tenants.length) }, worker));
    return out.sort((a, b) => a.tenantId - b.tenantId);
  }

  static clearSummaryCache() {
    this.summaryCache.clear();
  }
}
