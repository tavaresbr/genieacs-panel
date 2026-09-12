/**
 * O vocabulário da trilha, traduzido.
 *
 * O backend grava `action` como um código estável — `portal_password.revealed`,
 * `invite.accepted` —, e códigos estáveis são exatamente o que uma tabela lida
 * por um administrador de ISP não deve mostrar. A trilha da plataforma mostra o
 * código cru porque quem a lê é quem opera o SaaS; aqui quem lê é o dono do
 * painel, e para ele `portal_password.revealed` é ruído.
 *
 * O mapa é `Record<string, …>` e não `Record<AcaoConhecida, …>` de propósito:
 * `action` é `varchar(64)` livre no banco e `AuditLog.record` não valida contra
 * `ACTIONS` (`backend/src/models/AuditLog.js`). Uma ação que saiu do enum
 * continua nas linhas antigas, e uma ação nova pode chegar de um backend mais
 * novo que este frontend. Nos dois casos a tela mostra o código cru, que é
 * pouco, mas é mais do que uma célula vazia.
 *
 * O que garante que as ações CONHECIDAS estejam todas aqui não é o tipo: é
 * `frontend/test/audit-actions.test.ts`, que importa `AuditLog.ACTIONS` do
 * backend e compara — o mesmo truque de `frontend/test/permissions.test.ts`,
 * pelo mesmo motivo.
 */

import type { TranslationKey } from '@/lib/i18n/dictionary'

export const AUDIT_ACTION_LABEL_KEYS: Record<string, TranslationKey> = {
  'portal_password.revealed': 'audit.action.portalPasswordRevealed',
  'portal_password.reset': 'audit.action.portalPasswordReset',
  'genieacs.url_changed': 'audit.action.genieacsUrlChanged',
  'genieacs.auth_changed': 'audit.action.genieacsAuthChanged',
  'operator.role_changed': 'audit.action.operatorRoleChanged',
  'operator.removed': 'audit.action.operatorRemoved',
  'operator.created': 'audit.action.operatorCreated',
  'invite.created': 'audit.action.inviteCreated',
  'invite.accepted': 'audit.action.inviteAccepted',
  'invite.revoked': 'audit.action.inviteRevoked',
  'tenant.status_changed': 'audit.action.tenantStatusChanged',
  'tenant.exported': 'audit.action.tenantExported',
  'tenant.billing_changed': 'audit.action.tenantBillingChanged',
  'subscription.changed': 'audit.action.subscriptionChanged',
  'tenant.renamed': 'audit.action.tenantRenamed',
  'tenant.slug_changed': 'audit.action.tenantSlugChanged',
  'login_email.changed': 'audit.action.loginEmailChanged',
  'login_email.verified': 'audit.action.loginEmailVerified',
  'password_reset.requested': 'audit.action.passwordResetRequested',
  'password_reset.completed': 'audit.action.passwordResetCompleted',
  'platform.impersonated': 'audit.action.platformImpersonated',
  'subscriber_account.retired': 'audit.action.subscriberAccountRetired'
}

/** A chave da frase, ou `null` para a ação que este frontend não conhece. */
export function auditActionLabelKey(action: string): TranslationKey | null {
  return AUDIT_ACTION_LABEL_KEYS[action] ?? null
}
