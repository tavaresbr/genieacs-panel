import { getDb } from '../config/database.js';

/**
 * A trilha do plano de controle.
 *
 * Deliberadamente NÃO lida por `tdb`, pelo mesmo motivo de `tenants` e
 * `platform_admins`: ela é ACIMA de qualquer provedor. Filtrá-la pelo escopo
 * faria a listagem devolver só o que aconteceu com o provedor em que quem
 * pergunta está logado, e quem pergunta aqui opera o SaaS inteiro.
 *
 * `tenant_id` é inteiro simples e não chave estrangeira — ver a fábrica da
 * tabela. A linha que diz que um provedor foi apagado é a única desta tabela
 * que não pode faltar, e uma FK a apagaria junto com ele.
 */
class PlatformAudit {
  static ACTIONS = Object.freeze({
    TENANT_CREATED: 'tenant.created',
    TENANT_STATUS_CHANGED: 'tenant.status_changed',
    // O nome ou o SUBDOMÍNIO de um provedor foram corrigidos. Uma ação para os
    // dois campos, com o que mudou nomeado no detalhe: a pergunta que se faz
    // desta linha é "quem mexeu no cadastro deste provedor", e separar em duas
    // ações obrigaria a fazê-la duas vezes.
    TENANT_IDENTITY_CHANGED: 'tenant.identity_changed',
    TENANT_DELETED: 'tenant.deleted',
    // Um provedor foi ligado (ou desligado) do gateway de pagamento. Ação
    // própria e não `TENANT_IDENTITY_CHANGED`: a pergunta que se faz desta
    // linha é "desde quando este cliente paga sozinho, e quem o ligou", e ela é
    // a que se faz quando um pagamento cai no provedor errado. O detalhe diz o
    // gateway e SE há vínculo — nunca o id do cliente, que é a chave que decide
    // para quem vai o crédito.
    TENANT_GATEWAY_CHANGED: 'tenant.gateway_changed',
    // A Fase 5: o que o plano de controle fez com a assinatura de um provedor.
    PLAN_CREATED: 'plan.created',
    PLAN_UPDATED: 'plan.updated',
    SUBSCRIPTION_PLAN_CHANGED: 'subscription.plan_changed',
    SUBSCRIPTION_STATUS_CHANGED: 'subscription.status_changed',
    PAYMENT_RECORDED: 'subscription.payment_recorded',
    // Quem trabalha para qual provedor, decidido de fora dele. É a ação mais
    // forte que o plano de controle tem: um vínculo escrito aqui vira uma
    // sessão legítima DENTRO de um ISP, com o cadastro inteiro atrás dela. Sem
    // estas duas linhas, vincular-se a um ISP e depois sair não deixaria
    // rastro em trilha nenhuma.
    // E quem CONVIDOU alguém que ainda não tem login para um provedor — o
    // caminho que dá a primeira conta a um provedor recém-criado. Linha própria
    // e não `MEMBER_ADDED`: no convite ninguém entrou na equipe ainda, e o que
    // aconteceu foi a cunhagem de uma credencial com validade. Quem aceitou, e
    // quando, é a trilha DO PROVEDOR que registra.
    MEMBER_INVITED: 'tenant.member_invited',
    MEMBER_ADDED: 'tenant.member_added',
    MEMBER_REMOVED: 'tenant.member_removed',
    // Quem pediu para olhar o painel de qual cliente. Gravada na cunhagem do
    // bilhete — antes de a sessão existir —, porque é o pedido que é o ato do
    // plano de controle. Que a sessão tenha de fato começado é o que a trilha
    // do provedor registra, e é lá que a pergunta "entraram no meu painel?"
    // é feita.
    TENANT_IMPERSONATED: 'tenant.impersonated',
    // Quem deu a chave do reino a quem. São as duas únicas ações desta tabela
    // que não falam de um provedor — `tenant_id` sai nulo nelas de propósito,
    // porque o cadastro do plano de controle está ACIMA de qualquer provedor e
    // apontar uma delas para um seria inventar um recorte que não existe.
    //
    // E são as duas que mais importam: quem está neste cadastro cria e apaga
    // provedores, muda o que cada um paga e abre sessão de leitura no painel de
    // qualquer cliente. Sem estas linhas, a promoção que precede tudo isso
    // seria o único passo sem rastro da cadeia inteira.
    PLATFORM_ADMIN_GRANTED: 'platform_admin.granted',
    PLATFORM_ADMIN_REVOKED: 'platform_admin.revoked'
  });

  /**
   * Escreve. Como em `AuditLog`, não lança: a ação que a linha ia registrar já
   * aconteceu quando a escrita falha.
   *
   * A exceção que vale nomear: na exclusão, quem chama grava ANTES de apagar e
   * confere o retorno. Ali a trilha não é registro do que houve, é condição
   * para que aconteça — apagar um provedor sem conseguir registrar é apagar sem
   * deixar rastro, e isso não se faz.
   */
  static async record({
    action, actorUserId = null, actorUsername = null,
    tenant = null, detail = null, ip = null
  }) {
    try {
      await getDb()('platform_audit').insert({
        actor_user_id: actorUserId,
        actor_username: actorUsername ? String(actorUsername).slice(0, 64) : null,
        action,
        tenant_id: tenant?.id ?? null,
        tenant_slug: tenant?.slug ? String(tenant.slug).slice(0, 64) : null,
        tenant_name: tenant?.name ? String(tenant.name).slice(0, 128) : null,
        detail: PlatformAudit.serializeDetail(detail),
        ip: ip ? String(ip).slice(0, 64) : null
      });
      return true;
    } catch (error) {
      console.error('Platform audit write failed:', action, error.message);
      return false;
    }
  }

  static serializeDetail(detail) {
    if (detail === null || detail === undefined) return null;
    try {
      return JSON.stringify(detail).slice(0, 4000);
    } catch {
      return null;
    }
  }

  static async fromRequest(req, entrada) {
    try {
      return await PlatformAudit.record({
        ...entrada,
        actorUserId: req?.user?.userId ?? null,
        actorUsername: req?.user?.username ?? null,
        ip: req?.ip ?? null
      });
    } catch (error) {
      console.error('Platform audit write failed:', entrada?.action, error.message);
      return false;
    }
  }

  /** As ações mais recentes primeiro, paginadas por cursor. */
  static async list({ limit = 50, before = null } = {}) {
    let query = getDb()('platform_audit')
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));
    if (before) query = query.where('id', '<', Number(before));
    return query;
  }
}

export default PlatformAudit;
