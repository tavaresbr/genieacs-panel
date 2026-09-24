import { IS_SAAS } from './edition.js';
import { currentTenantId } from './tenantContext.js';
import { getDb } from './database.js';

/**
 * A fronteira entre o que a plataforma configura e o que o provedor configura.
 *
 * Na SaaS, parte da configuração é infraestrutura da plataforma e não do
 * provedor: o endereço e a credencial do GenieACS de cada um (quem hospeda o
 * ACS é a plataforma) e o servidor Evolution que atende todos os números. O
 * provedor continua vendo essas coisas — o status, o teste de conexão —, mas
 * quem escreve é o console, ou a caixa da plataforma no caso do Evolution.
 *
 * Na self-hosted não existe console: o dono da instalação é o provedor, e
 * tudo continua editável na tela de Configuração dele, como sempre foi.
 *
 * A caixa da plataforma (`kind = 'platform'`) é a exceção dentro da SaaS: é
 * nela que o administrador da plataforma edita o que vale para todos, então
 * ela nunca é "gerenciada pela plataforma" — ela É a plataforma.
 */

/** Chaves de `settings` que só o console grava na SaaS. */
export const PLATFORM_MANAGED_SETTING_KEYS = Object.freeze(['genieAcsUrl']);

/**
 * Os campos do WhatsApp que descrevem o SERVIDOR Evolution, e não o uso que o
 * provedor faz dele. Na SaaS eles vêm da caixa da plataforma.
 */
export const WA_SERVER_FIELDS = Object.freeze(['allowedHosts', 'webhookBaseUrl', 'managedUrl', 'managedAdminKey']);

/** Se ESTE tenant tem a configuração de infraestrutura nas mãos da plataforma. */
export function platformManages(tenant) {
  return IS_SAAS && (tenant?.kind ?? 'provider') !== 'platform';
}

/** O mesmo, para o provedor em escopo. */
export async function platformManagesCurrentTenant() {
  if (!IS_SAAS) return false;
  const tenant = await getDb()('tenants').where({ id: currentTenantId() }).first();
  return platformManages(tenant);
}
