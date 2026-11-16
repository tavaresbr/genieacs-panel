import { IS_SAAS } from '../config/edition.js';
import PlatformAdmin from '../models/PlatformAdmin.js';
import Tenant from '../models/Tenant.js';

/**
 * Quem escreve no catálogo de equipamentos da caixa da plataforma.
 *
 * Na SaaS, o catálogo da caixa (`tenants.kind = 'platform'`) não é de um
 * provedor: é o padrão de TODOS. É dele que o provedor novo herda os perfis, é
 * para ele que o "restaurar padrão" de cada provedor volta, e é ele que o
 * console propaga. Um `wifi_password_path` trocado ali chega, cedo ou tarde, à
 * troca de senha de WiFi de cliente de outro ISP — inclusive pelo portal do
 * assinante.
 *
 * `catalogue.write` não basta para isso, pelo mesmo motivo que
 * `whatsapp.config` não basta para trocar o servidor Evolution da caixa (ver
 * `WhatsAppController.updateConfig`): a capacidade é de qualquer `admin` da
 * equipe da caixa, e a equipe da caixa não é o cadastro da plataforma. Aqui se
 * pede o cadastro, lido fresco, e uma sessão que não seja personificação — esta
 * já é de quem está no cadastro, mas é uma sessão de atendimento DENTRO de um
 * provedor, e o catálogo padrão se edita pela sessão da própria pessoa.
 *
 * Fora da caixa nada muda: o catálogo de um provedor é dele, e
 * `catalogue.write` segue sendo a regra. No self-hosted não há caixa, e o
 * catálogo é de quem opera a instalação. A leitura não passa por aqui.
 *
 * Vem DEPOIS de `authenticateToken` e `requirePermission`, então `req.user` e
 * `req.tenantId` já são da sessão hidratada.
 */
export async function requirePlatformCatalogueAuthority(req, res, next) {
  if (!IS_SAAS) return next();
  try {
    const tenant = req.tenantId ? await Tenant.findById(req.tenantId) : null;
    if (tenant?.kind !== 'platform') return next();
    if (!req.user?.impersonation && await PlatformAdmin.has(req.user?.userId)) return next();
  } catch (error) {
    return next(error);
  }
  return res.status(403).json({
    success: false,
    code: 'platform_admin_only',
    message: req.t('vendor.platformAdminOnly')
  });
}

export default requirePlatformCatalogueAuthority;
