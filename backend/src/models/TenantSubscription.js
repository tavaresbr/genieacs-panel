import { getDb, tdb } from '../config/database.js';
import { normalizeStatus, SUBSCRIPTION_STATUSES } from '../config/subscription.js';

/**
 * A assinatura de um provedor: uma linha, um estado comercial.
 *
 * O vocabulário — quais estados existem e o que cada um deixa acontecer — mora
 * em `config/subscription.js`, de propósito: quem precisa responder "este
 * provedor pode salvar?" não deveria ter de carregar um model e uma conexão de
 * banco junto. Aqui fica só a leitura e a escrita da linha.
 */
class TenantSubscription {
  /**
   * A assinatura do provedor em escopo, ou `null` se não houver linha.
   *
   * `null` é um resultado legítimo e não um erro: uma instalação self-hosted
   * nunca teve assinatura, e quem chama decide o que fazer com a ausência —
   * ver o portão, onde essa decisão está escrita com o motivo.
   */
  static async current() {
    return (await tdb('tenant_subscriptions').first()) ?? null;
  }

  /**
   * A assinatura de um provedor NOMEADO, sem depender de escopo.
   *
   * tenant-scope-exempt: o plano de controle administra provedores de fora,
   * então a pergunta aqui é sempre "a de qual", e nunca "a do que está em
   * escopo" — o escopo, ali, é o do host do console, que é outro provedor.
   */
  static async findByTenantId(tenantId) {
    const id = Number(tenantId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return (await getDb()('tenant_subscriptions').where({ tenant_id: id }).first()) ?? null;
  }

  /**
   * Cria a assinatura de um provedor recém-criado.
   *
   * `trial` é o padrão porque é o que um cadastro novo é. Quem já existia no
   * dia em que esta tabela nasceu recebeu `active` pela migration, e a
   * diferença está escrita lá.
   *
   * tenant-scope-exempt: chamada logo depois de criar o provedor, de dentro do
   * plano de controle, que está no escopo de OUTRO provedor.
   */
  static async createFor(tenantId, { status = 'trial', trialEndsAt = null, reason = null } = {}) {
    const id = Number(tenantId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid tenant id');
    const agora = new Date();
    await getDb()('tenant_subscriptions').insert({
      tenant_id: id,
      status: normalizeStatus(status),
      trial_ends_at: trialEndsAt,
      status_reason: reason,
      status_changed_at: agora,
      created_at: agora,
      updated_at: agora
    });
    return this.findByTenantId(id);
  }

  /**
   * Muda o estado comercial, devolvendo `{ from, to }` — ou `null` se não havia
   * linha.
   *
   * Devolve o estado ANTERIOR porque é o que a trilha de auditoria precisa
   * escrever, e lê-lo depois da escrita seria ler o novo. A leitura e a escrita
   * acontecem na mesma transação pelo mesmo motivo: duas mudanças simultâneas
   * gravariam duas linhas de trilha dizendo que vieram do mesmo lugar.
   *
   * tenant-scope-exempt: idem `findByTenantId` — o alvo é nomeado por quem
   * administra, de fora.
   */
  static async setStatus(tenantId, status, { reason = null, currentPeriodEnd } = {}) {
    const id = Number(tenantId);
    if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid tenant id');
    if (!SUBSCRIPTION_STATUSES.includes(status)) {
      throw new Error(`Unknown subscription status: ${status}`);
    }
    return getDb().transaction(async (trx) => {
      const atual = await trx('tenant_subscriptions')
        .where({ tenant_id: id })
        .forUpdate()
        .first();
      if (!atual) return null;
      const patch = {
        status,
        status_reason: reason,
        status_changed_at: new Date(),
        updated_at: new Date()
      };
      if (currentPeriodEnd !== undefined) patch.current_period_end = currentPeriodEnd;
      // tenant-scope-exempt: o filtro é o `tenant_id` nomeado por quem
      // administra de fora, escrito à mão logo acima e aqui — e não o escopo,
      // que neste request é o do provedor do console.
      await trx('tenant_subscriptions').where({ tenant_id: id }).update(patch);
      return { from: atual.status, to: status };
    });
  }

  /**
   * As assinaturas de vários provedores, por id.
   *
   * Uma consulta e não N: o console lista dezenas de provedores, e uma leitura
   * por linha da lista é o padrão que transforma uma tela em espera.
   *
   * tenant-scope-exempt: é a visão do plano de controle sobre todos.
   */
  static async byTenantIds(ids = []) {
    const alvos = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    if (!alvos.length) return new Map();
    const linhas = await getDb()('tenant_subscriptions').whereIn('tenant_id', alvos);
    return new Map(linhas.map((linha) => [Number(linha.tenant_id), linha]));
  }

  /** Como a assinatura aparece numa resposta. Nada aqui é segredo. */
  static present(row) {
    if (!row) return null;
    return {
      status: normalizeStatus(row.status),
      trialEndsAt: row.trial_ends_at ?? null,
      currentPeriodEnd: row.current_period_end ?? null,
      statusReason: row.status_reason ?? null,
      statusChangedAt: row.status_changed_at ?? null
    };
  }
}

export default TenantSubscription;
