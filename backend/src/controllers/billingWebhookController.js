import crypto from 'node:crypto';
import { getDb } from '../config/database.js';
import { runInTenant } from '../config/tenantContext.js';
import { asaasBilling, AsaasBillingProvider } from '../services/billing/asaasBillingProvider.js';
import BillingCharge from '../models/BillingCharge.js';
import { effectiveWebhookToken } from '../services/billing/asaasSettingsService.js';

/**
 * A entrega do gateway de pagamento: o provedor pagou, e o painel volta a
 * escrever sozinho.
 *
 * Até aqui o pagamento era um botão no console — alguém conferindo extrato e
 * marcando à mão. Com dez clientes isso passa; com cinquenta é uma pessoa por
 * dia, e é uma pessoa que erra.
 *
 * ## As três decisões de exposição, copiadas dos dois webhooks que já existem
 *
 * 1. **A credencial é do DEPLOY, não de um provedor.** Há uma conta só no
 *    gateway, a nossa, e por isso o token mora na caixa da PLATAFORMA — gravado
 *    pelo console, em Integrações — com `BILLING_WEBHOOK_TOKEN` no ambiente
 *    como o que vale quando o console não gravou nenhum (era a única fonte
 *    antes da tela existir). Comparada em tempo constante, e sem o token configurado a rota responde
 *    404 em vez de aceitar: uma rota de dinheiro aberta porque alguém esqueceu
 *    uma variável é a pior maneira de descobrir que ela existe.
 * 2. **404 quando não há o que atender, 401 uniforme quando a credencial não
 *    presta.** A resposta nunca diz qual parte falhou, e nunca diz se o
 *    provedor existe: o gateway é público e as tentativas são gratuitas.
 * 3. **200 para tudo que se escolhe ignorar.** Reentrega, evento que não é
 *    pagamento, pagamento que não resolve provedor nenhum — todos 2xx, porque
 *    um não-2xx faz o gateway reentregar em laço para sempre. Não-2xx fica para
 *    falha genuína deste lado, que é o único caso em que reentregar ajuda.
 *
 * ## Por que o provedor sai do corpo e não do host
 *
 * A rota é montada ACIMA do resolvedor de provedor. A entrega chega no endereço
 * que o operador digitou no painel do gateway — o apex, provavelmente — e o
 * apex não nomeia provedor nenhum: resolvida por host, ela levaria 404 antes de
 * chegar aqui. Quem sabe de quem é o dinheiro é o corpo, e o `runInTenant`
 * abaixo é o que faz o crédito cair na assinatura certa.
 */

/**
 * O token do deploy, ou nulo.
 *
 * O gravado pelo console (Integrações → Asaas) ganha; `BILLING_WEBHOOK_TOKEN`
 * é o que vale quando o console nunca gravou nenhum — ver
 * `asaasSettingsService`. Lido a cada entrega, com o cache curto de lá: o
 * token trocado pelo console passa a valer neste processo na hora e nos outros
 * em segundos.
 */
async function tokenConfigurado() {
  return effectiveWebhookToken();
}

/**
 * Compara duas credenciais sem vazar o tamanho nem o prefixo pelo tempo.
 *
 * SHA-256 dos dois lados antes do `timingSafeEqual`, que é a forma que
 * `waWebhookAuth` já usa e pelo mesmo motivo: `timingSafeEqual` lança quando os
 * buffers têm tamanhos diferentes, e um erro por tamanho é, ele mesmo, um canal
 * lateral sobre o comprimento do segredo. Com o digest os dois lados têm sempre
 * 32 bytes.
 */
function credenciaisIguais(a, b) {
  const da = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const db = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(da, db);
}

/**
 * De qual provedor é esta entrega.
 *
 * Duas chaves, nesta ordem:
 *
 * 1. **A nossa própria referência** (`externalReference`), quando fomos nós que
 *    criamos a cobrança. É preferida porque é escrita por este painel e não
 *    depende de o cadastro do cliente no gateway estar ligado a quem se pensa.
 * 2. **O id do cliente no gateway**, para a cobrança emitida lá dentro, à mão —
 *    que é como os primeiros contratos vão ser cobrados.
 *
 * `tenants` é tabela compartilhada, então esta leitura não precisa de
 * `runUnscoped` nem de razão escrita: é exatamente a razão de as duas colunas
 * morarem ali e não numa tabela nova escopada.
 */
export async function resolveTenantDaEntrega({ reference, customerRef }, gateway = 'asaas') {
  const db = getDb();

  // `tenant:<id>` ou `tenant:<id>:<período>`. O sufixo é o que a emissão
  // acrescenta para que a referência diga QUAL cobrança e não só de quem — e a
  // forma antiga continua valendo, porque uma cobrança criada à mão no painel
  // do gateway não tem período nenhum a declarar.
  const daReferencia = String(reference ?? '').match(/^tenant:(\d+)(?::|$)/);
  if (daReferencia) {
    const linha = await db('tenants').where({ id: Number(daReferencia[1]) }).first();
    // `active` e não qualquer status: creditar um provedor apagado ou suspenso
    // por decisão de gente é escrever numa assinatura que ninguém vai ler.
    if (linha && linha.status === 'active') return linha.id;
    return null;
  }

  if (customerRef) {
    const linha = await db('tenants')
      .where({ billing_gateway: gateway, billing_customer_ref: customerRef })
      .first();
    if (linha && linha.status === 'active') return linha.id;
  }
  return null;
}

/** Marca como paga a cobrança que o gateway nomeia. Nunca derruba o crédito. */
async function marcarCobrancaPaga(gatewayChargeId) {
  try {
    const cobranca = await BillingCharge.byGatewayId(gatewayChargeId);
    if (cobranca && cobranca.status !== 'paid') {
      await BillingCharge.update(cobranca.id, { status: 'paid' });
    }
  } catch (error) {
    console.warn(`Billing webhook: could not settle the charge: ${error.message}`);
  }
}

/**
 * De que estado a cobrança pode ir para cada um dos estados do ciclo.
 *
 * O gateway reentrega e não garante ordem, e é contra isso que esta tabela
 * existe: um `PAYMENT_OVERDUE` atrasado que chegasse depois do pagamento
 * reabriria como `overdue` uma cobrança paga — e o provedor receberia um aviso
 * de atraso do que já pagou. Então só se atrasa o que está em aberto, só se
 * cancela o que não foi pago, e o estorno vale sobre qualquer coisa: é o único
 * dos três que diz que dinheiro SAIU, e ele não pode ser engolido por uma
 * etiqueta anterior.
 */
const TRANSICOES_DO_CICLO = Object.freeze({
  overdue: new Set(['pending', 'failed']),
  canceled: new Set(['pending', 'failed', 'overdue']),
  refunded: new Set(['pending', 'failed', 'overdue', 'paid', 'canceled'])
});

class BillingWebhookController {
  /**
   * Um evento do ciclo de vida: a cobrança muda de etiqueta, e nada mais.
   *
   * Nenhum crédito é tocado aqui — nem o estorno desfaz o período que o
   * pagamento comprou. Desfazer é decidir se o provedor volta a `past_due`,
   * se perde os dias já corridos, se o estorno foi um erro do gateway; é
   * decisão de gente, com contexto que esta rota não tem. O que esta rota faz é
   * deixar isso VISÍVEL: a cobrança vira `refunded` na tela do provedor e do
   * console, e o log do processo grita.
   *
   * 200 em todos os caminhos, inclusive no erro deste lado: nenhum destes
   * eventos move dinheiro para dentro, e o pior resultado de perder um é uma
   * etiqueta desatualizada — que não vale um laço de reentrega do gateway.
   */
  static async atualizarCiclo(ciclo, res) {
    const tenantId = await resolveTenantDaEntrega(ciclo, asaasBilling.name);
    if (!tenantId) {
      console.warn(
        `Billing webhook: no provider for ${ciclo.event} on payment ${ciclo.externalId} `
        + `(reference=${ciclo.reference ?? '-'} customer=${ciclo.customerRef ?? '-'})`
      );
      return res.json({ success: true, code: 'unattributed' });
    }

    try {
      const code = await runInTenant(tenantId, async () => {
        const cobranca = await BillingCharge.byGatewayId(ciclo.externalId);
        if (!cobranca) return 'no_charge';
        if (!TRANSICOES_DO_CICLO[ciclo.status]?.has(cobranca.status)) return 'unchanged';
        await BillingCharge.update(cobranca.id, { status: ciclo.status });
        return 'charge_updated';
      });

      if (ciclo.status === 'refunded') {
        console.warn(
          `Billing webhook: payment ${ciclo.externalId} for provider ${tenantId} was REFUNDED — `
          + 'the subscription credit was NOT reversed; review it in the console'
        );
      }
      return res.json({ success: true, code });
    } catch (error) {
      console.error(`Billing webhook: could not apply ${ciclo.event} for provider ${tenantId}:`, error.message);
      return res.json({ success: true, code: 'update_failed' });
    }
  }

  static async receive(req, res) {
    const esperado = await tokenConfigurado();
    if (!esperado) {
      // Ninguém ligou gateway nenhum neste deploy. Mesma resposta do webhook do
      // SGP quando não há destino: não há o que atender aqui.
      return res.status(404).json({ success: false, code: 'webhook_disabled' });
    }

    const recebido = req.get('asaas-access-token') ?? '';
    if (!credenciaisIguais(recebido, esperado)) {
      // Só no log do processo, e sem dizer nada de quem mandou: a resposta é a
      // mesma para credencial errada, ausente e malformada.
      console.warn('Rejected a billing webhook delivery: invalid access token');
      return res.status(401).json({ success: false, code: 'invalid_token' });
    }

    const leitura = AsaasBillingProvider.interpretar(req.body);
    if (!leitura) {
      // Não é dinheiro entrando — mas pode ser o resto da vida da cobrança:
      // venceu, foi apagada no gateway, foi estornada.
      const ciclo = AsaasBillingProvider.interpretarCiclo(req.body);
      if (ciclo) return BillingWebhookController.atualizarCiclo(ciclo, res);

      // O caminho de todo evento que não é dinheiro entrando — e também o de um
      // campo que mudou de nome do outro lado. O corpo vai para o log do
      // processo porque é ele que diz qual dos dois aconteceu, e essa é a
      // pergunta que alguém vai ter na primeira semana.
      console.warn(
        `Billing webhook: nothing to do with event "${req.body?.event ?? '(none)'}"`
      );
      return res.json({ success: true, code: 'ignored' });
    }

    const tenantId = await resolveTenantDaEntrega(leitura, asaasBilling.name);
    if (!tenantId) {
      // 200, e não 404: o gateway reentregaria para sempre uma cobrança que a
      // plataforma genuinamente não sabe atribuir, e a fila dele não é o lugar
      // de guardar esse problema. Fica no log, que é onde alguém procura
      // quando um cliente diz que pagou.
      console.error(
        `Billing webhook: no provider for payment ${leitura.externalId} `
        + `(reference=${leitura.reference ?? '-'} customer=${leitura.customerRef ?? '-'})`
      );
      return res.json({ success: true, code: 'unattributed' });
    }

    try {
      // Daqui para baixo, como o provedor que pagou. É o escopo que diz de quem
      // é o dinheiro — `recordPayment` não recebe `tenantId` justamente para
      // que ninguém credite o provedor errado passando o id errado.
      const { duplicate, underpaid, expectedCents, paidCents } = await runInTenant(tenantId, async () => {
        const resultado = await asaasBilling.recordPayment({
          amountCents: leitura.amountCents,
          currency: 'BRL',
          externalId: leitura.externalId,
          actorUserId: null
        });
        // E a cobrança que o painel emitiu para isto, se houver, deixa de estar
        // em aberto. Fecha o par: a emissão gravou o id do gateway, o pagamento
        // chega com o mesmo id, e é assim que "o que está em aberto" para de
        // incluir o que já foi pago.
        //
        // Depois do crédito, e sem poder derrubá-lo: uma falha aqui deixa uma
        // cobrança `pending` que foi paga — feio, visível e corrigível. O caso
        // oposto seria dinheiro recebido e não creditado.
        //
        // E só quando o valor fecha. Uma cobrança paga pela metade continua
        // `pending` porque é isso que ela é: em aberto. Marcá-la paga aqui
        // apagaria da lista de contas a receber exatamente a linha que alguém
        // precisa olhar — e o período, que não andou, ficaria sem explicação
        // em lugar nenhum.
        // Nem quando o valor é curto, nem numa reentrega.
        //
        // O curto é o óbvio: uma cobrança paga pela metade continua `pending`
        // porque é isso que ela é. A reentrega é a armadilha — `recordPayment`
        // volta cedo por `duplicate` e não reavalia o valor, então `underpaid`
        // vem indefinido ali; sem esta segunda condição, a SEGUNDA entrega de
        // um pagamento curto quitaria a cobrança que a primeira deixou em
        // aberto, e o gateway reentrega por desenho. Não é preciso reavaliar
        // nada: a primeira entrega já fez a coisa certa, e repeti-la é no
        // máximo um no-op.
        if (!resultado.duplicate && !resultado.underpaid) {
          await marcarCobrancaPaga(leitura.externalId);
        }
        return resultado;
      });

      if (underpaid) {
        // No log do processo, e não só no extrato: é a única coisa nesta rota
        // que representa dinheiro a menos do que o combinado, e quem procura
        // "por que o fulano não renovou" procura aqui primeiro.
        console.warn(
          `Billing webhook: payment ${leitura.externalId} for provider ${tenantId} paid `
          + `${paidCents} of ${expectedCents} cents — recorded, period NOT extended`
        );
      }

      // 200 nos três: o dinheiro chegou e foi registrado, e o que o gateway
      // precisa saber é que não há o que reentregar. A diferença entre eles é
      // para o log do gateway e para quem lê esta rota, não para a fila dele.
      return res.json({
        success: true,
        code: duplicate ? 'duplicate' : underpaid ? 'underpaid' : 'recorded'
      });
    } catch (error) {
      // Aqui sim: falhou deste lado, e reentregar resolve.
      console.error(`Billing webhook failed for provider ${tenantId}:`, error.message);
      return res.status(500).json({ success: false, code: 'record_failed' });
    }
  }
}

export default BillingWebhookController;
