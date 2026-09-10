import Tenant from '../models/Tenant.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import TenantExportService from '../services/tenantExportService.js';
import AuditLog from '../models/AuditLog.js';
import SubscriptionService from '../services/subscriptionService.js';
import DeviceService from '../services/deviceService.js';
import { EDITION } from '../config/edition.js';
import { panelBaseDomain } from '../middleware/tenantResolver.js';

/**
 * What a provider will admit to before anybody has signed in.
 *
 * The login screen has to render the provider's own name, and it has to do so
 * with no token — so this is the one route that answers a stranger with
 * something drawn from the `tenants` row. That makes it the enumeration surface
 * of the whole deployment, and everything below is written against that.
 */
const NAME_MAX_LENGTH = 128;

class TenantController {
  /**
   * `PATCH /api/tenant` — the provider renames itself.
   *
   * This is what `settings.appName` used to be: the name on the sidebar, the
   * login screen and the browser tab. It moves onto the `tenants` row because
   * that row is the provider — the console lists it, the public profile
   * answers it, and a name kept in two places was a name shown differently on
   * two screens. Audited on the provider's own trail: renaming is not
   * sensitive, but it is the kind of change somebody asks "who did that" about.
   */
  static async rename(req, res) {
    try {
      const name = String(req.body?.name ?? '').trim();
      if (name.length < 1 || name.length > NAME_MAX_LENGTH) {
        return res.status(400).json(createErrorResponse(req.t('tenant.nameInvalid')));
      }
      const before = await Tenant.findById(req.tenantId);
      if (!before) {
        return res.status(404).json(createErrorResponse(req.t('common.notFound')));
      }
      await Tenant.rename(req.tenantId, name);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TENANT_RENAMED,
        subjectType: 'tenant',
        subjectId: req.tenantId,
        detail: { from: before.name, to: name }
      });
      return res.json(createResponse(req.t('tenant.renamed'), { name, slug: before.slug }));
    } catch (error) {
      console.error('Rename tenant error:', error);
      return res.status(500).json(createErrorResponse(req.t('tenant.renameFailed'), error.message));
    }
  }

  /**
   * `GET /api/tenant/subscription`: o plano, o estado e o uso — a tela de
   * "plano e uso" do provedor, e a placa que a tela de bloqueio lê.
   *
   * A contagem de ONTs vem do GenieACS e pode falhar; ela vira `null` sem
   * derrubar o resto (ver `SubscriptionService.usage`). Sem preço: o preço é
   * do console.
   */
  static async getSubscription(req, res) {
    try {
      const usage = await SubscriptionService.usage({
        countDevices: () => DeviceService.countDevicesFromGenieAcs()
      });
      return res.json(createResponse(req.t('subscription.retrieved'), usage));
    } catch (error) {
      console.error('Get subscription error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('subscription.retrieveFailed'), error.message)
      );
    }
  }

  /**
   * O cadastro inteiro deste provedor, num arquivo.
   *
   * `Content-Disposition: attachment` com o slug e a data no nome: o arquivo
   * costuma ir para um e-mail ou um chamado, e um `export.json` sem dono vira
   * três arquivos iguais na pasta de quem recebeu.
   *
   * Auditado, e é uma das ações mais sensíveis que existem aqui — devolve todo
   * o cadastro de assinantes de uma vez. Sem registro, um operador de saída
   * baixaria a base inteira e nada no painel diria que isso aconteceu.
   */
  static async exportTenant(req, res) {
    try {
      const arquivo = await TenantExportService.build();
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TENANT_EXPORTED,
        subjectType: 'tenant',
        subjectId: arquivo.manifest.tenant?.id ?? null,
        detail: { rowCounts: arquivo.manifest.rowCounts }
      });

      const nome = [
        'skygenpanel',
        arquivo.manifest.tenant?.slug || 'export',
        new Date().toISOString().slice(0, 10)
      ].join('-');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${nome}.json"`);
      return res.send(JSON.stringify(arquivo, null, 2));
    } catch (error) {
      console.error('Tenant export error:', error);
      return res.status(500).json(createErrorResponse(req.t('tenant.exportFailed'), error.message));
    }
  }

  /**
   * `GET /api/tenant/public`.
   *
   * There is no lookup here, and that is the design. The provider is whatever
   * `resolveTenant` already put on the request from the `Host` header; this
   * route accepts no slug, no id and no query of its own. A route that took the
   * provider from the caller would let anyone read any provider's row by asking
   * for it, which is precisely the hole the host-based resolver exists to close
   * — and it would close it nowhere else, because every other route would still
   * be scoped by host.
   *
   * The corollary is that an unknown host never gets this far: the resolver
   * answers 404 ahead of the routes, and so does a host naming a provider that
   * is not active, with the same body. Those two answers must stay identical,
   * because the difference between them is "this ISP is our customer and is
   * behind on its bill" — a fact about somebody else's business that we would
   * be publishing. Nothing in this file may introduce a way to tell them apart:
   * no status in the payload, no distinct message, no distinct status code, and
   * no branch that only a real-but-suspended provider can reach.
   *
   * On rate limiting: `/api` is already behind `apiLimiter` in `app.js`, mounted
   * above the resolver, so this route arrives limited at 300/min per
   * provider-and-address without anything further here. A second limiter on
   * this path specifically would be theatre for the threat that actually
   * matters. Enumeration does not need THIS route — the resolver's 404 is
   * visible on every path under `/api`, so a prober sweeping slugs would just
   * ask `/api/auth/login` and read the same signal at the same cost. The
   * ceiling that would bite a sweep is an address-keyed one ahead of the
   * resolver, since `apiLimiter`'s key folds in the slug and so hands a
   * prober a fresh budget for every slug guessed. That belongs where the
   * resolver is mounted, protecting every route at once; bolting it on here
   * would slow nothing down and would read as if the problem were solved.
   */
  static async getPublicProfile(req, res) {
    try {
      const tenant = await Tenant.findPublicById(req.tenantId);

      // The row the resolver blessed is gone — a provider deleted while the
      // process was up, since the resolver caches slug to id for the life of
      // the process. Answered as the resolver would have answered had it read
      // the table a moment later, deliberately reusing `common.notFound`, so
      // this narrow race cannot become a third distinguishable outcome.
      if (!tenant) {
        return res.status(404).json(createErrorResponse(req.t('common.notFound')));
      }

      // Spelled out field by field rather than spread from the row. The model
      // already selects only the public columns, and this is the second of the
      // two locks on the same door: adding a field to what a stranger sees now
      // takes an edit here AND an edit there, and trips the test that pins the
      // exact key set.
      //
      // `id` is absent on purpose. The screen has no use for it — it renders a
      // name — and it is the stable primary key of a `tenants` row. Handing it
      // to unauthenticated callers invites clients to start sending it back,
      // and a tenant id in a request body is the exact shape of parameter that
      // becomes an IDOR the day some future route trusts it over the host. The
      // caller already named the provider by connecting to its host; the id
      // tells them nothing more about who they reached and gives them a handle
      // we would rather they never held.
      //
      // `slug` is present, and it is not a disclosure: on a deployment with
      // subdomains it is the very string the caller typed to get here, and on
      // one without, it is `default` for every install there has ever been. It
      // earns its place by being the stable key the client can cache branding
      // under, and by letting the screen say which provider it thinks it is
      // talking to when a proxy has rewritten the host underneath it.
      // Two more facts a stranger may know, both about the DEPLOYMENT rather
      // than about this provider. `edition` decides whether the screen offers
      // signup and whether it shows the database switcher — the SaaS edition is
      // not a secret, it is the product; every subdomain already says so.
      // `panelBaseDomain` is what signup needs to promise an address, and it is
      // the string in the caller's own address bar.
      return res.json(createResponse(req.t('tenant.publicRetrieved'), {
        name: tenant.name,
        slug: tenant.slug,
        edition: EDITION,
        panelBaseDomain: panelBaseDomain()
      }));
    } catch (error) {
      console.error('Get public tenant profile error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('tenant.publicFailed'), error.message)
      );
    }
  }
}

export default TenantController;
