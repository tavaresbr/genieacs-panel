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
    TENANT_DELETED: 'tenant.deleted'
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
