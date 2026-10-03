import { currentTenantId } from '../config/tenantContext.js';
import { translate } from '../i18n/index.js';
import { DEFAULT_LOCALE } from '../i18n/config.js';
import Tenant from '../models/Tenant.js';
import TenantUser from '../models/TenantUser.js';
import { mailTransport, panelUrlFor } from './mail/index.js';
import SubscriptionService from './subscriptionService.js';
import BillingCharge from '../models/BillingCharge.js';
import { PRODUCT_NAME } from '../config/brand.js';
import PlatformNotifyService from './platformNotifyService.js';
import ChargeIssuingService from './chargeIssuingService.js';
import SubscriptionReminderSend from '../models/SubscriptionReminderSend.js';
import SelfBillingService from './selfBillingService.js';

/**
 * Os lembretes que chegam ANTES do bloqueio — e depois dele.
 *
 * Até aqui, o provedor descobria que o teste acabou — ou que o período pago
 * venceu — tomando 402 ao salvar. O painel sabia a data, mostrava a data na
 * tela de plano, e não dizia nada. Isso transforma uma cobrança legítima em
 * chamado de suporte, e o chamado chega com o cliente já irritado.
 *
 * ## Uma régua de três etapas, e cada uma sai uma vez só
 *
 * Era um aviso único por prazo. Virou uma régua (migração 0092): `before`
 * (até cinco dias antes, junto com a emissão da fatura), `due` (no
 * vencimento) e `after` (três dias depois, enquanto ninguém pagou). As janelas
 * estão em `SubscriptionService.pendingReminder`; só sai a etapa da janela de
 * agora — a que passou sem sair não sai atrasada.
 *
 * O agendador roda de minuto em minuto. Sem memória, isso seriam mil e
 * quatrocentas mensagens por dia para o mesmo endereço. A memória é
 * `subscription_reminder_sends`, com `(tenant_id, due_at, step)` único: a
 * linha nasce ANTES do envio (`SubscriptionReminderSend.claim`) e quem perde a
 * corrida não manda. A chave é o PRAZO, e não a hora do aviso: um pagamento
 * que empurra `renews_at` faz a régua recomeçar sozinha no prazo novo.
 * `subscriptions.expiry_warned_for` continua sendo gravada, por compatibilidade.
 *
 * ## Para quem
 *
 * `tenants.billing_email` primeiro, porque é o campo que existe para isso — mas
 * ele é NULO em todo provedor de hoje, já que o cadastro fiscal acabou de
 * nascer. A reserva são os endereços de quem é `owner` do provedor: é a conta
 * que o cadastro obriga a ter e-mail, e é quem decide pagar. E o WhatsApp da
 * plataforma, para `tenants.billing_phone`. Sem nenhum dos dois não sai
 * mensagem, e isso é registrado — um provedor sem endereço de cobrança é um
 * problema comercial, não um erro de programa.
 *
 * ## O idioma
 *
 * `DEFAULT_LOCALE`, porque não há outro: nem `users` nem `tenants` guardam
 * idioma, e o job não tem requisição de onde tirar um `Accept-Language`. Está
 * escrito aqui para que quem acrescentar a coluna um dia saiba onde ligá-la.
 */
class SubscriptionNoticeService {
  /**
   * Os endereços que recebem o aviso deste provedor, sem repetição.
   *
   * Preferência e não união: mandar para o financeiro E para todos os donos
   * faria a mesma mensagem chegar três vezes em empresas pequenas, onde as
   * duas coisas são a mesma pessoa.
   */
  static async recipients(tenant) {
    const cobranca = String(tenant?.billing_email ?? '').trim();
    if (cobranca) return [cobranca];
    const equipe = await TenantUser.listForTenant(tenant.id);
    const donos = equipe
      .filter((pessoa) => pessoa.role === 'owner')
      .map((pessoa) => String(pessoa.email ?? '').trim())
      .filter(Boolean);
    return [...new Set(donos)];
  }

  /**
   * Quanto tempo uma passada fica dona da etapa enquanto manda. Folga larga
   * sobre o SMTP e o WhatsApp; vencida, outra passada a retoma.
   */
  static CLAIM_MS = 5 * 60 * 1000;

  /** O valor, na moeda, como o destinatário o lê. */
  static formatAmount(cents, currency) {
    const valor = Number(cents) / 100;
    try {
      return new Intl.NumberFormat(DEFAULT_LOCALE, { style: 'currency', currency: currency || 'BRL' }).format(valor);
    } catch {
      return `${currency || ''} ${valor.toFixed(2)}`.trim();
    }
  }

  /**
   * Manda o lembrete da etapa atual do provedor em escopo, se houver um.
   *
   * Devolve o que aconteceu, para o agendador poder contar sem precisar
   * adivinhar: `{ sent: false, reason }` é o caso normal e não é erro.
   *
   * A etapa só fica marcada quando a mensagem SAIU por algum canal. Marcar
   * antes deixaria um provedor sem lembrete nenhum no dia em que o SMTP
   * estivesse fora do ar — e a marca é justamente o que impediria a segunda
   * tentativa. Por isso a linha tomada é apagada quando nada sai.
   *
   * O agendador chama isto DEPOIS da emissão (`ChargeIssuingService`), para que
   * o `before` — que cai junto com a emissão, cinco dias antes — já leve o link
   * da fatura.
   */
  static async notifyCurrent({ now = new Date(), tenant: doLaco = null } = {}) {
    const transporte = mailTransport();
    const temEmail = transporte.name !== 'none';

    const { subscription, plan } = await SubscriptionService.current();
    const pendente = SubscriptionService.pendingReminder(subscription, now, plan);
    if (!pendente) return { sent: false, reason: 'nothing_due' };

    // O agendador já tem a linha do provedor na mão (`forEachTenant` a entrega
    // inteira); quem chama sem ela paga a leitura.
    const tenant = doLaco ?? await Tenant.findById(currentTenantId());
    if (!tenant) return { sent: false, reason: 'tenant_gone' };
    // A plataforma não é cliente dela mesma.
    if (tenant.kind === 'platform') return { sent: false, reason: 'platform_tenant' };

    const para = temEmail ? await this.recipients(tenant) : [];
    const fone = String(tenant.billing_phone ?? '').trim();
    if (!para.length && !fone) {
      return { sent: false, reason: temEmail ? 'no_recipient' : 'no_transport' };
    }

    // A data do prazo no fuso da cobrança — a mesma chave da fatura — é a
    // chave da etapa e também o que a mensagem diz. ISO e curta: o idioma do
    // destinatário é desconhecido, e `12/09` é ambíguo.
    const dueAt = ChargeIssuingService.periodKey(pendente.deadline);
    const garra = await SubscriptionReminderSend.claim({
      dueAt, step: pendente.step, until: new Date(now.getTime() + this.CLAIM_MS), now
    });
    if (!garra) return { sent: false, reason: 'already_sent', step: pendente.step };

    let canais = [];
    try {
      canais = await this.deliver({
        tenant, pendente, dueAt, para, fone, transporte, now, plan, subscription
      });
    } catch (error) {
      await SubscriptionReminderSend.release(garra).catch(() => {});
      throw error;
    }
    if (!canais.length) {
      await SubscriptionReminderSend.release(garra);
      return { sent: false, reason: para.length ? 'send_failed' : (temEmail ? 'no_recipient' : 'no_transport') };
    }

    await SubscriptionReminderSend.markSent(garra, { channels: canais, at: now });
    await SubscriptionService.markExpiryWarned(pendente.deadline);
    return {
      sent: true,
      kind: pendente.kind,
      step: pendente.step,
      expired: pendente.expired,
      recipients: para.length,
      whatsapp: canais.includes('whatsapp')
    };
  }

  /** Monta e manda a mensagem; devolve os canais por onde ela saiu. */
  static async deliver({
    tenant, pendente, dueAt, para, fone, transporte, now, plan, subscription = null
  }) {
    // A cobrança em aberto, se o painel já emitiu uma: é dela o link de pagar
    // e o valor de fato cobrado (que pode ser o da descida agendada, ou o que
    // o console mudou à mão). Sem ela, o preço do plano e o endereço do painel.
    const cobranca = await BillingCharge.currentOpen().catch(() => null);
    const paraPagar = cobranca?.invoice_url || null;
    // Sem cobrança, o que a emissão pediria: o plano da fatura deste prazo (o
    // da descida agendada, quando é para ele) com o cupom da assinatura.
    let centavos;
    let moeda;
    if (cobranca) {
      centavos = Number(cobranca.amount_cents);
      moeda = cobranca.currency || plan?.currency || 'BRL';
    } else {
      const daFatura = (subscription && await SelfBillingService.invoicePlanFor(subscription).catch(() => null)) || plan;
      centavos = subscription
        ? await SubscriptionService.effectivePriceCents(subscription, daFatura)
        : Number(daFatura?.price_cents ?? 0);
      moeda = daFatura?.currency || plan?.currency || 'BRL';
    }

    const dias = Math.max(0, Math.ceil(Math.abs(pendente.deadline.getTime() - now.getTime()) / 86_400_000));
    const vars = {
      provider: tenant.name || PRODUCT_NAME,
      date: dueAt,
      days: dias,
      amount: this.formatAmount(centavos, moeda),
      link: paraPagar || panelUrlFor(tenant) || ''
    };
    const etapa = pendente.step.charAt(0).toUpperCase() + pendente.step.slice(1);
    const chave = pendente.kind === 'trial'
      ? `subscription.reminder.trial${etapa}`
      : `subscription.reminder.${pendente.step}`;
    const assunto = translate(DEFAULT_LOCALE, `${chave}Subject`, vars);
    const texto = translate(DEFAULT_LOCALE, `${chave}Body`, vars);

    const enviados = await Promise.all(para.map((endereco) => transporte.send({
      to: endereco, subject: assunto, text: texto
    }).catch(() => false)));

    // O WhatsApp vai junto, com o mesmo texto. Melhor esforço.
    const porWhatsapp = fone
      ? await PlatformNotifyService.sendWhatsapp(fone, `*${assunto}*\n\n${texto}`)
      : false;

    const canais = [];
    if (enviados.some(Boolean)) canais.push('email');
    if (porWhatsapp) canais.push('whatsapp');
    return canais;
  }
}

export default SubscriptionNoticeService;
