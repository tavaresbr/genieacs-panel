import { currentTenantId } from '../config/tenantContext.js';
import { translate } from '../i18n/index.js';
import { DEFAULT_LOCALE } from '../i18n/config.js';
import Tenant from '../models/Tenant.js';
import TenantUser from '../models/TenantUser.js';
import { mailTransport, panelUrlFor } from './mail/index.js';
import SubscriptionService from './subscriptionService.js';
import BillingCharge from '../models/BillingCharge.js';

/**
 * O aviso que chega ANTES do bloqueio.
 *
 * Até aqui, o provedor descobria que o teste acabou — ou que o período pago
 * venceu — tomando 402 ao salvar. O painel sabia a data, mostrava a data na
 * tela de plano, e não dizia nada. Isso transforma uma cobrança legítima em
 * chamado de suporte, e o chamado chega com o cliente já irritado.
 *
 * ## Uma mensagem por prazo, nunca uma por passada
 *
 * O agendador roda de minuto em minuto. Sem memória, isso seriam mil e
 * quatrocentas mensagens por dia para o mesmo endereço — a maneira mais rápida
 * de treinar alguém a ignorar o aviso que importa. A memória é
 * `subscriptions.expiry_warned_for`, que guarda O PRAZO avisado e não a hora do
 * aviso: um pagamento que empurra `renews_at` faz a marca deixar de casar
 * sozinha, e o ciclo recomeça sem nenhum caminho precisar lembrar de limpar
 * nada. Ver `SubscriptionService.pendingExpiryNotice`.
 *
 * ## Para quem
 *
 * `tenants.billing_email` primeiro, porque é o campo que existe para isso — mas
 * ele é NULO em todo provedor de hoje, já que o cadastro fiscal acabou de
 * nascer. A reserva são os endereços de quem é `owner` do provedor: é a conta
 * que o cadastro obriga a ter e-mail, e é quem decide pagar. Sem nenhum dos
 * dois não sai mensagem, e isso é registrado — um provedor sem endereço de
 * cobrança é um problema comercial, não um erro de programa.
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
   * Manda o aviso do provedor em escopo, se houver um a mandar.
   *
   * Devolve o que aconteceu, para o agendador poder contar sem precisar
   * adivinhar: `{ sent: false, reason }` é o caso normal e não é erro.
   *
   * A marca só é gravada quando a mensagem SAIU. Marcar antes deixaria um
   * provedor sem aviso nenhum no dia em que o SMTP estivesse fora do ar — e a
   * marca é justamente o que impediria a segunda tentativa.
   */
  static async notifyCurrent({ now = new Date(), tenant: doLaco = null } = {}) {
    const transporte = mailTransport();
    if (transporte.name === 'none') return { sent: false, reason: 'no_transport' };

    // O plano junto, porque é dele que sai a janela do aviso: num plano anual
    // sete dias não é aviso, é notificação de que já era.
    const { subscription, plan } = await SubscriptionService.current();
    const pendente = SubscriptionService.pendingExpiryNotice(subscription, now, plan);
    if (!pendente) return { sent: false, reason: 'nothing_due' };

    // O agendador já tem a linha do provedor na mão (`forEachTenant` a entrega
    // inteira); quem chama sem ela paga a leitura.
    const tenant = doLaco ?? await Tenant.findById(currentTenantId());
    if (!tenant) return { sent: false, reason: 'tenant_gone' };

    const para = await this.recipients(tenant);
    if (!para.length) return { sent: false, reason: 'no_recipient' };

    const dias = Math.max(0, Math.ceil((pendente.deadline.getTime() - now.getTime()) / 86_400_000));

    // A cobrança em aberto, se o painel já emitiu uma.
    //
    // É por causa dela que a cobrança ganhou tabela: um aviso que diz "vence em
    // três dias" e não diz onde pagar transfere para o cliente o trabalho de
    // achar o boleto — e ele vai achar abrindo um chamado. Quando não há
    // cobrança emitida (provedor não ligado a gateway, plano de graça, cobrança
    // ainda não gerada), o link continua sendo o do painel, que é o que este
    // aviso sempre mandou.
    const cobranca = await BillingCharge.currentOpen().catch(() => null);
    const paraPagar = cobranca?.invoice_url || null;

    const vars = {
      provider: tenant.name || 'SkyGenPanel',
      // A data vai em ISO e curta: o idioma do destinatário é desconhecido, e
      // `12/09` é ambíguo entre metade do mundo e a outra metade.
      date: pendente.deadline.toISOString().slice(0, 10),
      days: dias,
      link: paraPagar || panelUrlFor(tenant) || ''
    };
    const sufixo = pendente.expired ? 'Expired' : 'Soon';
    const chave = `subscription.notice.${pendente.kind}${sufixo}`;

    const enviados = await Promise.all(para.map((endereco) => transporte.send({
      to: endereco,
      subject: translate(DEFAULT_LOCALE, `${chave}Subject`, vars),
      text: translate(DEFAULT_LOCALE, `${chave}Body`, vars)
    }).catch(() => false)));

    if (!enviados.some(Boolean)) return { sent: false, reason: 'send_failed' };

    await SubscriptionService.markExpiryWarned(pendente.deadline);
    return { sent: true, kind: pendente.kind, expired: pendente.expired, recipients: para.length };
  }
}

export default SubscriptionNoticeService;
