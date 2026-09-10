import { BillingProvider } from './billingProvider.js';
import SubscriptionService from '../subscriptionService.js';

/**
 * Nós marcamos pago.
 *
 * É o provedor de cobrança do MVP e o que o console usa: um humano recebeu o
 * Pix, o boleto ou a transferência por fora, e clica. `externalId` é a
 * referência que ele digitou — o id do Pix, o número do boleto — para que o
 * extrato responda "qual pagamento foi esse" seis meses depois.
 */
export class ManualBillingProvider extends BillingProvider {
  get name() {
    return 'manual';
  }

  async recordPayment({ amountCents, currency, externalId = null, actorUserId = null, now }) {
    return SubscriptionService.recordPayment({
      amountCents,
      currency,
      provider: this.name,
      externalId,
      actorUserId,
      ...(now ? { now } : {})
    });
  }
}

export const manualBilling = new ManualBillingProvider();

export default ManualBillingProvider;
