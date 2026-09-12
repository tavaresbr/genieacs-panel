import crypto from 'node:crypto';
import { getDb } from '../config/database.js';
import { runInTenant } from '../config/tenantContext.js';
import { asaasBilling, AsaasBillingProvider } from '../services/billing/asaasBillingProvider.js';

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
 * 1. **A credencial é do DEPLOY, não de um provedor.** `BILLING_WEBHOOK_TOKEN`
 *    no ambiente, no molde do `METRICS_TOKEN`, e não no `secretBox` — que
 *    guarda segredo POR provedor, e aqui há uma conta só no gateway, a nossa.
 *    Comparada em tempo constante, e sem o token configurado a rota responde
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

/** O token do deploy, ou nulo. Lido a cada entrega: o processo não o guarda. */
function tokenConfigurado() {
  const valor = String(process.env.BILLING_WEBHOOK_TOKEN ?? '').trim();
  return valor.length ? valor : null;
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

  const daReferencia = String(reference ?? '').match(/^tenant:(\d+)$/);
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

class BillingWebhookController {
  static async receive(req, res) {
    const esperado = tokenConfigurado();
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
      const { duplicate } = await runInTenant(tenantId, () => asaasBilling.recordPayment({
        amountCents: leitura.amountCents,
        currency: 'BRL',
        externalId: leitura.externalId,
        actorUserId: null
      }));
      return res.json({ success: true, code: duplicate ? 'duplicate' : 'recorded' });
    } catch (error) {
      // Aqui sim: falhou deste lado, e reentregar resolve.
      console.error(`Billing webhook failed for provider ${tenantId}:`, error.message);
      return res.status(500).json({ success: false, code: 'record_failed' });
    }
  }
}

export default BillingWebhookController;
