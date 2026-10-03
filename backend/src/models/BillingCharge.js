import { getDb, tdb, tinsertReturningId } from '../config/database.js';
import { runUnscoped } from '../config/tenantContext.js';
import BillingInvoice from './BillingInvoice.js';

/**
 * A cobrança que o painel emitiu a um provedor.
 *
 * Só por `tdb`/`tinsert`, como o extrato e a assinatura: quem chama abre o
 * escopo do provedor antes. Uma cobrança gravada fora do escopo do dono é uma
 * cobrança que o dono não vê — e, pior que no extrato, é um link de pagamento
 * pendurado no provedor errado.
 *
 * Ao contrário de `BillingEvent`, este modelo ATUALIZA. É a diferença que
 * justifica a tabela: uma cobrança tem ciclo de vida, e o extrato não tem.
 */

/**
 * O `last_error` da cobrança que o "isento de cobrança" cancelou — a marca que
 * o desligar procura para reabrir a do período atual
 * (`ChargeIssuingService.reopenExemptCanceled`). Não é erro: o console não a
 * mostra como "último erro". Cabe folgada nos 500 caracteres da coluna.
 */
export const EXEMPT_CANCEL_MARKER = 'billing_exempt: canceled by the billing exemption';

export const CHARGE_STATUSES = Object.freeze([
  /** Emitida, ninguém pagou ainda. É o estado em que ela nasce. */
  'pending',
  /** O webhook creditou o pagamento dela. */
  'paid',
  /** Cancelada — pelo console, ou porque o provedor saiu. */
  'canceled',
  /**
   * O gateway recusou a criação. Fica na tabela de propósito: sem esta linha,
   * "o cliente nunca recebeu a cobrança" e "ninguém tentou emitir" são o mesmo
   * silêncio, e são problemas com consertos opostos.
   */
  'failed',
  /**
   * Venceu e ninguém pagou (`PAYMENT_OVERDUE` do gateway). Continua EM ABERTO:
   * o link de pagamento vale, o aviso de vencimento o manda e a faxina de
   * períodos velhos a alcança — só o nome mudou, e é o nome que o provedor
   * precisa ler na tela para saber que está atrasado.
   */
  'overdue',
  /**
   * O dinheiro voltou para quem pagou — pelo botão de estorno do console, ou
   * no painel do gateway (`PAYMENT_REFUNDED`). Fechada: não há o que pagar
   * nela. O período que ela comprou é desfeito junto, pelos dois caminhos
   * (`SubscriptionService.reversePayment`), uma vez só.
   */
  'refunded'
]);

/**
 * Os estados em que ainda se deve dinheiro por uma cobrança. Uma lista só, e
 * não três `whereIn` escritos à mão: o `overdue` entrou depois e teria ficado
 * de fora de algum deles — e uma cobrança atrasada fora da lista de "em
 * aberto" é exatamente a que some da tela de quem precisa cobrar.
 */
export const OPEN_CHARGE_STATUSES = Object.freeze(['pending', 'failed', 'overdue']);

/**
 * `due_date` como `YYYY-MM-DD`, venha como vier.
 *
 * A coluna é `date`, e cada banco a devolve de um jeito: o SQLite, como o texto
 * gravado; o Postgres e o MySQL, como um `Date` à meia-noite LOCAL do processo.
 * Serializar esse `Date` com `toISOString` o levaria para UTC — e num servidor
 * a leste de Greenwich, o dia anterior. Os campos locais são os que o driver
 * preencheu, e são eles que se leem.
 */
function isoDateOf(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    const mes = String(valor.getMonth() + 1).padStart(2, '0');
    const dia = String(valor.getDate()).padStart(2, '0');
    return `${valor.getFullYear()}-${mes}-${dia}`;
  }
  return String(valor).slice(0, 10);
}

class BillingCharge {
  /** A cobrança de um período, ou nada. É a leitura de idempotência da emissão. */
  static async forPeriod(periodEnd, trx = null) {
    const chave = String(periodEnd ?? '').slice(0, 10);
    if (!chave) return null;
    return (await tdb('billing_charges', trx).where({ period_end: chave }).first()) || null;
  }

  /** Uma cobrança pelo id da linha, dentro do provedor em escopo. */
  static async findById(id, trx = null) {
    const numero = Number(id);
    if (!Number.isInteger(numero) || numero <= 0) return null;
    return (await tdb('billing_charges', trx).where({ id: numero }).first()) || null;
  }

  /** A cobrança que o gateway nomeia, dentro do provedor em escopo. */
  static async byGatewayId(gatewayChargeId) {
    const id = String(gatewayChargeId ?? '').slice(0, 128);
    if (!id) return null;
    return (await tdb('billing_charges').where({ gateway_charge_id: id }).first()) || null;
  }

  /**
   * Grava a cobrança do período ANTES de falar com o gateway.
   *
   * Antes, e não depois, porque é a linha que impede a segunda emissão: se ela
   * só nascesse com a resposta na mão, duas passadas do agendador que se
   * cruzassem criariam duas cobranças de verdade na mão de um cliente pagante.
   * O índice único `(tenant_id, period_end)` decide a corrida; esta inserção é
   * o bilhete que a ganha.
   */
  static async open({
    subscriptionId = null, periodEnd, amountCents, currency, provider, dueDate = null, claimUntil = null,
    planId = null, couponId = null
  }) {
    return tinsertReturningId('billing_charges', {
      // A linha nasce JÁ garrada por quem a inseriu — ver `claim`. Sem isto,
      // entre a inserção e a chamada ao gateway, outra passada que lesse a
      // linha nova sem `gateway_charge_id` a tomaria por "falhou no meio" e
      // emitiria de novo.
      issuing_until: claimUntil,
      subscription_id: subscriptionId,
      period_end: String(periodEnd).slice(0, 10),
      amount_cents: amountCents,
      currency: String(currency || 'BRL').toUpperCase().slice(0, 3),
      provider: String(provider).slice(0, 32),
      status: 'pending',
      due_date: dueDate,
      // Com que plano e cupom este valor foi calculado (0093) — ver
      // `BILLING_CHARGE_PRICING_COLUMNS`.
      plan_id: planId ?? null,
      coupon_id: couponId ?? null
    });
  }

  static async update(id, patch) {
    const changed = await tdb('billing_charges').where({ id })
      .update({ ...patch, updated_at: new Date() });
    return changed > 0;
  }

  /**
   * O que o gateway devolveu quando a criação deu certo.
   *
   * Condicional: só grava numa linha que AINDA não tem id no gateway. A garra
   * (`claim`) já impede duas emissões da mesma linha; esta condição é a
   * segunda tranca, para o caso em que a garra venceu no meio de uma chamada
   * lenta e outro a tomou. Aí as duas cobranças existem no gateway e só uma
   * pode ficar na linha — a primeira a gravar. Quem chega depois recebe
   * `false` e é quem precisa cancelar a sua do lado de lá.
   *
   * Solta a garra junto: a emissão acabou.
   */
  static async markIssued(id, { gatewayChargeId, invoiceUrl = null, dueDate = null }) {
    const changed = await tdb('billing_charges').where({ id }).whereNull('gateway_charge_id').update({
      gateway_charge_id: String(gatewayChargeId).slice(0, 128),
      invoice_url: invoiceUrl ? String(invoiceUrl).slice(0, 512) : null,
      ...(dueDate ? { due_date: dueDate } : {}),
      status: 'pending',
      last_error: null,
      issuing_until: null,
      updated_at: new Date()
    });
    return changed > 0;
  }

  /**
   * Toma a linha para falar com o gateway por ela, até `until` — ou não toma.
   *
   * Um `UPDATE` condicional, e só segue quem de fato mudou a linha: é o banco
   * que decide entre duas passadas que leram a mesma coisa ao mesmo tempo, do
   * mesmo jeito que o índice único decide entre duas inserções. A garra de
   * quem morreu no meio vence sozinha (`issuing_until` no passado), e a linha
   * volta a ser de quem a pedir.
   *
   * `unissued: true` (o padrão, que é o da emissão) só toma linha sem id no
   * gateway: uma linha já emitida não tem mais o que emitir. A troca de plano
   * pede `false`, porque é justamente a linha emitida que ela vai cancelar e
   * reemitir.
   *
   * @returns {Promise<boolean>} se esta chamada ficou com a linha.
   */
  static async claim(id, {
    until, now = new Date(), unissued = true, openOnly = false, statuses = null
  } = {}) {
    let query = tdb('billing_charges').where({ id })
      .where((livre) => livre.whereNull('issuing_until').orWhere('issuing_until', '<', now));
    if (unissued) query = query.whereNull('gateway_charge_id');
    // `openOnly` é o dos gestos do console: a leitura que decidiu "está em
    // aberto" e a garra são dois comandos, e entre eles o webhook pode ter
    // quitado a linha. Na mesma condição do `UPDATE`, quem toma a garra toma
    // uma linha que AINDA está em aberto — ou não toma nada.
    if (openOnly) query = query.whereIn('status', OPEN_CHARGE_STATUSES);
    // `statuses` é a mesma trava para o gesto que quer uma linha FECHADA — o
    // estorno, que só toma a cobrança que ainda está `paid`: entre a leitura e
    // a garra, o `PAYMENT_REFUNDED` do gateway pode tê-la estornado.
    if (Array.isArray(statuses) && statuses.length) query = query.whereIn('status', statuses);
    const changed = await query.update({ issuing_until: until, updated_at: new Date() });
    return changed > 0;
  }

  /** Solta a garra, quando quem a tomou desistiu sem emitir nem falhar. */
  static async release(id) {
    return BillingCharge.update(id, { issuing_until: null });
  }

  /**
   * A tentativa falhou. `attempts` sobe e o motivo fica — e é o motivo que
   * separa "o gateway recusou o CNPJ" de "a rede caiu", que é a diferença entre
   * um chamado para o cliente e um para a infraestrutura.
   */
  static async markFailed(id, motivo, { retryAfterMs = 0 } = {}) {
    // `increment` e não ler-somar-gravar: duas passadas que se cruzassem
    // perderiam um incremento, e o teto de tentativas é justamente o que
    // impede uma cobrança recusada de ser tentada para sempre.
    const changed = await tdb('billing_charges').where({ id }).update({
      status: 'failed',
      last_error: String(motivo ?? '').slice(0, 500),
      next_attempt_at: retryAfterMs > 0 ? new Date(Date.now() + retryAfterMs) : null,
      // A tentativa acabou, mal, e a linha volta a ser de quem vier depois
      // da espera.
      issuing_until: null,
      updated_at: new Date()
    });
    await tdb('billing_charges').where({ id }).increment('attempts', 1);
    return changed > 0;
  }

  /**
   * Devolve a cobrança do período ao ponto de partida, com outro valor — para
   * ser emitida de novo.
   *
   * É o que a troca de plano feita pelo provedor faz com a cobrança em aberto
   * do período: a do gateway (se havia) já foi cancelada lá por quem chama, e
   * aqui a linha esquece tudo o que dizia respeito a ELA — o id no gateway, a
   * página de pagamento, as tentativas, o último erro — e fica com o preço
   * novo, `pending` e sem id. É o estado que a emissão reconhece como "ainda
   * não saiu", e por isso é o próximo passe dela (ou o "pagar agora") que a
   * emite, pela porta de sempre.
   *
   * A MESMA linha, e não uma nova: o índice único `(tenant_id, period_end)` é
   * o que impede duas cobranças do mesmo período, e abrir outra linha exigiria
   * apagar esta — perdendo o histórico de que houve uma cobrança antes.
   *
   * `invoice_url` vai junto porque o link antigo leva a uma cobrança apagada;
   * mostrá-lo na tela do provedor seria mandá-lo pagar o que não existe mais.
   *
   * O id velho NÃO some: vai para `superseded_charges`, com o valor que
   * aquela cobrança pedia. Cancelar no gateway não impede que alguém pague o
   * boleto velho que já estava impresso, e quando esse pagamento chegar a
   * conferência precisa saber quanto AQUELA cobrança pedia — ver
   * `bySupersededGatewayId`.
   *
   * Quem chama segura a garra da linha (`claim` com `unissued: false`); a
   * condição sobre `gateway_charge_id` é a segunda tranca: se a linha mudou
   * de id entre a leitura e aqui, alguém emitiu no meio, e reescrevê-la
   * apagaria uma cobrança viva. Devolve `false` nesse caso, e solta a garra
   * quando dá certo.
   *
   * @returns {Promise<boolean>}
   */
  static async resetForReissue(id, {
    amountCents, currency, holdUntil = null, planId = undefined, couponId = undefined
  }) {
    const linha = await BillingCharge.findById(id);
    if (!linha) return false;
    const anteriores = BillingCharge.supersededOf(linha);
    if (linha.gateway_charge_id) {
      anteriores.push({
        id: String(linha.gateway_charge_id),
        amountCents: Number(linha.amount_cents),
        currency: String(linha.currency || 'BRL').toUpperCase(),
        at: new Date().toISOString()
      });
    }
    let query = tdb('billing_charges').where({ id });
    query = linha.gateway_charge_id
      ? query.where({ gateway_charge_id: linha.gateway_charge_id })
      : query.whereNull('gateway_charge_id');
    const changed = await query.update({
      amount_cents: amountCents,
      currency: String(currency || 'BRL').toUpperCase().slice(0, 3),
      gateway_charge_id: null,
      invoice_url: null,
      status: 'pending',
      attempts: 0,
      next_attempt_at: null,
      last_error: null,
      // A garra fica com quem reprecificou quando ele pede (`holdUntil`): a
      // troca de plano ainda vai gravar o plano novo (ou a descida agendada)
      // DEPOIS daqui, e uma linha solta entre as duas escritas seria emitida
      // pelo agendador ou por um "pagar agora" com o preço que o estado velho
      // ainda diz. Quem a segura a solta logo antes de reemitir.
      issuing_until: holdUntil,
      superseded_charges: anteriores.length ? JSON.stringify(anteriores) : null,
      // O valor novo é o preço de um plano: o desconto dado à cobrança velha
      // pelo console não passa para a reemitida.
      amount_overridden_at: null,
      // O plano e o cupom do preço novo (0093), quando quem reprecifica os
      // diz; sem eles (a reabertura da isenção, que mantém o valor), ficam.
      ...(planId !== undefined ? { plan_id: planId } : {}),
      ...(couponId !== undefined ? { coupon_id: couponId } : {}),
      updated_at: new Date()
    });
    return changed > 0;
  }

  /** As cobranças que esta linha já foi, lidas da coluna — nunca lança. */
  static supersededOf(linha) {
    if (!linha?.superseded_charges) return [];
    try {
      const lista = JSON.parse(linha.superseded_charges);
      return Array.isArray(lista) ? lista.filter((item) => item && item.id) : [];
    } catch {
      return [];
    }
  }

  /**
   * A linha que JÁ FOI a cobrança que o gateway nomeia, e o que ela pedia.
   *
   * Só é perguntada quando `byGatewayId` não achou nada: o id é de uma
   * cobrança que a troca de plano cancelou e substituiu. A busca é um `LIKE`
   * sobre o JSON (com `!` como escape, que os três bancos aceitam do mesmo
   * jeito), e a confirmação é pelo JSON lido — o `LIKE` só estreita, quem
   * decide é a igualdade exata do id.
   *
   * @returns {Promise<{ row: object, superseded: { id: string, amountCents: number,
   *   currency: string } } | null>}
   */
  static async bySupersededGatewayId(gatewayChargeId) {
    const id = String(gatewayChargeId ?? '').slice(0, 128);
    if (!id) return null;
    const escapado = JSON.stringify(id).replace(/[!%_]/g, (c) => `!${c}`);
    const linhas = await tdb('billing_charges')
      .whereNotNull('superseded_charges')
      .whereRaw("superseded_charges LIKE ? ESCAPE '!'", [`%${escapado}%`])
      .limit(5);
    for (const linha of linhas) {
      const achada = BillingCharge.supersededOf(linha).find((item) => String(item.id) === id);
      if (achada) return { row: linha, superseded: achada };
    }
    return null;
  }

  /** As cobranças ainda em aberto de períodos anteriores a este. */
  static async openBefore(periodEnd) {
    const chave = String(periodEnd ?? '').slice(0, 10);
    if (!chave) return [];
    return tdb('billing_charges')
      .whereIn('status', OPEN_CHARGE_STATUSES)
      .where('period_end', '<', chave)
      .orderBy('period_end');
  }

  /**
   * Todas as cobranças em aberto deste provedor, de qualquer período — o que
   * o "isento de cobrança" cancela ao ser ligado.
   */
  static async openAll() {
    return tdb('billing_charges')
      .whereIn('status', OPEN_CHARGE_STATUSES)
      .orderBy('period_end')
      .orderBy('id');
  }

  /** A cobrança em aberto mais recente deste provedor — a que o aviso linka. */
  static async currentOpen() {
    return (await tdb('billing_charges')
      .whereIn('status', OPEN_CHARGE_STATUSES)
      .orderBy('period_end', 'desc')
      .first()) || null;
  }

  static async listRecent({ limit = 50 } = {}) {
    const teto = Math.min(200, Math.max(1, Number(limit) || 50));
    return tdb('billing_charges').orderBy('id', 'desc').limit(teto);
  }

  /**
   * As cobranças em aberto de TODOS os provedores, numa consulta só — o que a
   * tela de Assinaturas do console soma e mostra ao lado de cada provedor.
   *
   * `runUnscoped` e o marcador pelo mesmo motivo de
   * `Subscription.listWithPlans`: a leitura não tem filtro de provedor DE
   * PROPÓSITO, porque quem pergunta está acima de todos eles, e a sentinela de
   * SQL derrubaria a consulta crua sem a razão escrita. Uma consulta, e não uma
   * por provedor: com cinquenta clientes, cinquenta `runInTenant` seriam a
   * tela mais lenta do console para responder a pergunta mais simples dele.
   *
   * O índice `(tenant_id, status)` não serve a um `WHERE status IN (...)` sem
   * provedor, e não precisa: em aberto há no máximo uma ou duas por provedor.
   */
  static async openAcrossTenants() {
    // tenant-scope-exempt: listagem do plano de controle, acima dos provedores.
    return runUnscoped('the console sums every provider\'s open charges', () => getDb()('billing_charges')
      .whereIn('status', OPEN_CHARGE_STATUSES)
      .orderBy('period_end', 'desc')
      .orderBy('id', 'desc'));
  }

  /**
   * Uma cobrança como o CONSOLE a vê: tudo o que `present` esconde do provedor.
   *
   * O id no gateway (é por ele que alguém acha a cobrança no painel da Asaas),
   * as tentativas e o último erro (é o que diz por que ela não saiu) e as
   * cobranças que esta linha JÁ FOI — a troca de plano cancela no gateway e
   * reemite, e o boleto velho ainda pode ser pago: quem olha a linha precisa
   * saber que existe um id antigo que também quita este período.
   *
   * O link de pagamento vai cru, de qualquer estado: quem opera o console abre
   * a página do gateway de uma cobrança paga para conferir o recibo, que é
   * exatamente o que a tela do provedor não deve convidar a fazer.
   */
  static presentForConsole(row, invoiceRow = null) {
    if (!row) return null;
    return {
      id: row.id,
      periodEnd: row.period_end,
      amountCents: Number(row.amount_cents),
      currency: row.currency,
      status: row.status,
      dueDate: isoDateOf(row.due_date),
      invoiceUrl: row.invoice_url ?? null,
      provider: row.provider ?? null,
      gatewayChargeId: row.gateway_charge_id ?? null,
      attempts: Number(row.attempts ?? 0),
      // Quando o console mudou o valor à mão — nulo quando o valor é o preço
      // de um plano. A emissão não reprecifica uma cobrança marcada assim.
      amountOverriddenAt: row.amount_overridden_at ?? null,
      // A marca da isenção não é erro de ninguém (ver `EXEMPT_CANCEL_MARKER`).
      lastError: row.last_error && row.last_error !== EXEMPT_CANCEL_MARKER ? row.last_error : null,
      createdAt: row.created_at ?? null,
      updatedAt: row.updated_at ?? null,
      superseded: BillingCharge.supersededOf(row).map((item) => ({
        gatewayChargeId: String(item.id),
        amountCents: Number(item.amountCents)
      })),
      // A NFS-e desta cobrança, quando há — lida por quem chama (`forCharges`).
      invoice: BillingInvoice.presentForConsole(invoiceRow)
    };
  }

  /**
   * Uma cobrança como o PROVEDOR pode vê-la.
   *
   * A lista de colunas é curta de propósito, e o que ficou de fora é a parte
   * interessante: `gateway_charge_id` (o id dela na Asaas, que é correlação
   * nossa com o gateway e não endereço de pagamento), `attempts` e
   * `next_attempt_at` (o backoff da emissão, que é mecânica nossa) e
   * `last_error` — texto cru que o gateway devolveu, o único aqui que pode
   * carregar detalhe da NOSSA conta na Asaas para dentro da tela de um cliente.
   *
   * O que sobra é o que o provedor precisa para pagar e para conferir o que
   * pagou: de que período é, quanto, até quando, em que pé está, e onde se
   * paga.
   */
  static present(row, invoiceRow = null) {
    if (!row) return null;
    return {
      id: row.id,
      periodEnd: row.period_end,
      amountCents: Number(row.amount_cents),
      currency: row.currency,
      status: row.status,
      dueDate: row.due_date ?? null,
      // Só de cobrança que ainda se paga. Um link de cobrança já quitada é um
      // botão que leva a uma página do gateway dizendo que não há o que pagar —
      // e, pior, convida a pagar de novo.
      invoiceUrl: OPEN_CHARGE_STATUSES.includes(row.status) ? (row.invoice_url ?? null) : null,
      createdAt: row.created_at ?? null,
      // A nota fiscal (NFS-e) desta cobrança: estado, número e PDF — sem o erro.
      invoice: BillingInvoice.present(invoiceRow)
    };
  }
}

export default BillingCharge;
export { BillingCharge, isoDateOf };
