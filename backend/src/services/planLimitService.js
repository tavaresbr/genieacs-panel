import { tdb } from '../config/database.js';
import AppState from '../models/AppState.js';
import TenantSubscription from '../models/TenantSubscription.js';
import { atLimit, limitsFrom, UNLIMITED } from '../config/plans.js';
import { IS_SAAS } from '../config/edition.js';

/**
 * Quanto deste plano já foi usado, e o que ainda cabe.
 *
 * Duas responsabilidades, e vale separar o que cada uma significa:
 *
 * - **Medir** é sempre possível e nunca recusa nada. É o que a tela de plano e
 *   uso mostra, e é a base da conversa de upgrade.
 * - **Barrar** só acontece onde existe uma requisição para recusar. São dois
 *   lugares: criar operador e criar conta de assinante. O teto de ONTs não é um
 *   deles, e o porquê está escrito em `config/plans.js` — quando a contagem
 *   passa, o equipamento já informou ao ACS do provedor, e não há nada a
 *   recusar que não seja esconder a rede dele do próprio dono.
 *
 * ## Uma corrida que este arquivo NÃO fecha
 *
 * Contar e depois inserir é uma janela: dois administradores criando o terceiro
 * operador ao mesmo tempo num plano de três passam os dois. Isso é aceitável
 * aqui, e não seria numa checagem de segurança — a diferença é o que o erro
 * custa. Um operador a mais é uma linha de cobrança, corrigível na fatura ou
 * numa conversa. Fechar a janela custaria uma trava por provedor em todo
 * cadastro de operador, e a trava erra para o lado de recusar quem tinha
 * direito. O limite é comercial; o rigor certo é o comercial.
 */
/** Onde a varredura anota o que o teto a impediu de criar. */
const SKIPPED_KEY = 'plan_subscriber_accounts_skipped';

class PlanLimitService {
  /**
   * Os tetos deste provedor, com as exceções negociadas aplicadas.
   *
   * Numa instalação self-hosted não há assinatura conosco e nada é limitado —
   * o painel é do ISP, roda na máquina dele, e um teto ali seria uma restrição
   * que ninguém vendeu.
   */
  static async limits() {
    if (!IS_SAAS) return limitsFrom(null);
    return limitsFrom(await TenantSubscription.current());
  }

  /** Quantos operadores este provedor tem. */
  static async operatorCount() {
    const [linha] = await tdb('tenant_users').count({ n: '*' });
    return Number(linha?.n ?? 0);
  }

  /**
   * Quantos operadores este provedor já COMPROMETEU.
   *
   * Vínculos mais convites em aberto, e a soma é o ponto. Contando só os
   * vínculos, um plano de três operadores com três vínculos e cinco convites
   * pendentes vira oito no dia em que os links forem clicados — e o limite não
   * teria recusado nada em momento nenhum, porque cada aceite, isolado, é o
   * primeiro a passar do teto e chega quando o administrador que o criou já foi
   * embora da tela.
   */
  static async committedOperatorCount() {
    const vinculos = await this.operatorCount();
    const [linha] = await tdb('tenant_invites')
      .whereNull('accepted_at')
      .whereNull('revoked_at')
      .where('expires_at', '>', new Date())
      .count({ n: '*' });
    return vinculos + Number(linha?.n ?? 0);
  }

  /**
   * Quantas contas de assinante ATIVAS este provedor tem.
   *
   * Ativas, e não todas as linhas. Aposentar uma conta não apaga a linha — ela
   * fica `active: false` com o device id neutralizado, porque é histórico. Uma
   * ONT reprovisionada para outro assinante aposenta uma e cria outra, então
   * contando linhas o provedor "cresceria" a cada troca de titular sem nunca
   * ter ganhado um assinante. É por assinante ativo que o ISP paga.
   */
  static async subscriberAccountCount() {
    const [linha] = await tdb('customer_accounts').where({ active: true }).count({ n: '*' });
    return Number(linha?.n ?? 0);
  }

  /**
   * Quantas contas a última varredura deixou de criar por causa do teto.
   *
   * Guardado porque a varredura roda sem ninguém olhando: parar de criar contas
   * em silêncio é o assinante ficar sem portal e ninguém saber por quê. Este
   * número aparece na tela de plano e uso, ao lado do teto que o causou.
   */
  static async subscriberAccountsSkipped() {
    const bruto = await AppState.get(SKIPPED_KEY);
    const n = Number(bruto);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  /** Registra o que a varredura deixou de criar. Zero apaga a marca. */
  static async recordSubscriberAccountsSkipped(quantas) {
    try {
      await AppState.upsert(SKIPPED_KEY, String(Math.max(0, Number(quantas) || 0)));
    } catch (error) {
      console.warn(`Could not record the skipped subscriber accounts: ${error.message}`);
    }
  }

  /**
   * Se cabe mais um operador. Devolve `{ ok }` ou `{ ok: false, limit, used }`.
   *
   * @param {{ countInvites?: boolean }} [opts] Se convites em aberto contam.
   *   Contam ao CRIAR (vínculo ou convite), porque cada um é uma vaga já
   *   prometida. Não contam ao ACEITAR: ali o convite que está sendo usado já
   *   está na conta, e somá-lo de novo recusaria o último convite de todo
   *   provedor exatamente no teto.
   */
  static async canAddOperator({ countInvites = true } = {}) {
    const { maxOperators } = await this.limits();
    if (maxOperators === UNLIMITED) return { ok: true };
    const usados = countInvites
      ? await this.committedOperatorCount()
      : await this.operatorCount();
    if (atLimit(usados, maxOperators)) {
      return { ok: false, limit: maxOperators, used: usados };
    }
    return { ok: true };
  }

  /** Se cabe mais uma conta de assinante. */
  static async canAddSubscriberAccounts(quantas = 1) {
    const { maxSubscriberAccounts } = await this.limits();
    if (maxSubscriberAccounts === UNLIMITED) return { ok: true, allowed: quantas };
    const usados = await this.subscriberAccountCount();
    const sobra = Math.max(0, Number(maxSubscriberAccounts) - usados);
    if (sobra <= 0) return { ok: false, limit: maxSubscriberAccounts, used: usados, allowed: 0 };
    return { ok: sobra >= quantas, limit: maxSubscriberAccounts, used: usados, allowed: Math.min(sobra, quantas) };
  }

  /**
   * O uso deste provedor, para a tela de plano e uso.
   *
   * Sem a contagem de ONTs: ela vem do ACS do provedor, custa uma requisição de
   * rede e é a única medida aqui que pode falhar ou demorar. Quem quiser mostrá-la
   * pede à `DeviceService`, e a tela decide se espera — misturar a medida que
   * depende de um servidor de terceiro com as três que são um `COUNT` local faria
   * a tela inteira falhar quando o ACS do cliente estiver fora do ar.
   */
  static async usage() {
    const limites = await this.limits();
    const [operadores, convites, assinantes] = await Promise.all([
      this.operatorCount(),
      this.committedOperatorCount(),
      this.subscriberAccountCount()
    ]);
    return {
      plan: limites.planCode,
      operators: {
        used: operadores,
        committed: convites,
        limit: limites.maxOperators
      },
      subscriberAccounts: {
        used: assinantes,
        limit: limites.maxSubscriberAccounts,
        // O que a varredura não criou. Zero na esmagadora maioria dos dias; é
        // justamente por isso que precisa aparecer no dia em que não for.
        skipped: await this.subscriberAccountsSkipped()
      }
    };
  }
}

export default PlanLimitService;
