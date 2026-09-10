import Tenant from '../models/Tenant.js';
import Subscription from '../models/Subscription.js';
import SubscriptionService from '../services/subscriptionService.js';
import PlatformAudit from '../models/PlatformAudit.js';
import { SCHEMA_TABLES } from '../config/migrations.js';
import { SCOPED_TABLES } from '../config/tenantScope.js';
import { forgetResolvedTenant } from '../middleware/tenantResolver.js';
import AuditLog from '../models/AuditLog.js';
import { runInTenant } from '../config/tenantContext.js';
import { getDb } from '../config/database.js';
import { seedDefaults } from '../config/seed.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';
import { slugProblem } from '../utils/slug.js';

const NAME_MAX_LENGTH = 128;

/**
 * The provider registry: create, list, suspend, reactivate — e, desde a onda
 * 22, apagar.
 *
 * A versão anterior deste comentário dizia que apagar não existia, e o
 * argumento continua inteiro: apagar leva os aparelhos, os assinantes e o
 * histórico de mensagens de um ISP junto, e um botão que faz isso num clique
 * não deveria existir. O que mudou não foi o argumento, foi a exigência: LGPD
 * dá ao titular o direito de sumir, e um contrato cancelado precisa de um fim.
 *
 * A conciliação está na forma da operação, não na sua ausência. Apagar exige
 * **quatro** coisas ao mesmo tempo, e nenhuma delas acontece por acidente:
 *
 * 1. estar no plano de controle;
 * 2. o provedor estar **suspenso** — o que faz da exclusão um segundo passo,
 *    com um estado reversível no meio, e não um clique;
 * 3. o slug digitado de volta, exato;
 * 4. não ser o último provedor do deployment.
 *
 * E a linha da trilha da plataforma é gravada ANTES, com a contagem do que vai
 * sumir: se ela não puder ser gravada, não se apaga. Apagar sem deixar rastro é
 * a única forma de apagar que é indefensável.
 */

/** The only two values `tenants.status` is allowed to take. */
export const TENANT_STATUSES = Object.freeze(['active', 'suspended']);


/**
 * The provider as the console shows it: `operators` is how many people work
 * there, `subscription` is the plan and the state it is in (null only for a
 * provider the 0034 backfill somehow missed, which the seed repairs at boot).
 */
function present(tenant, operators, subscription = null) {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    operators,
    subscription: subscription ? {
      status: SubscriptionService.effectiveStatus(subscription).status,
      storedStatus: subscription.status,
      planId: subscription.plan_id,
      planCode: subscription.plan_code ?? null,
      planName: subscription.plan_name ?? null,
      trialEndsAt: subscription.trial_ends_at ?? null,
      renewsAt: subscription.renews_at ?? null
    } : null,
    createdAt: tenant.created_at ?? null
  };
}

/** One query for every provider's subscription, keyed by provider id. */
async function subscriptionsByTenant() {
  const rows = await Subscription.listWithPlans();
  return new Map(rows.map((row) => [Number(row.tenant_id), row]));
}

class PlatformController {
  static async listTenants(req, res) {
    try {
      const tenants = await Tenant.list();
      const counts = await Tenant.operatorCounts();
      const subscriptions = await subscriptionsByTenant();
      return res.json(createResponse('Tenants retrieved successfully', {
        tenants: tenants.map((tenant) => present(
          tenant,
          counts.get(Number(tenant.id)) || 0,
          subscriptions.get(Number(tenant.id)) || null
        ))
      }));
    } catch (error) {
      console.error('List tenants error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to list providers', error.message)
      );
    }
  }

  /**
   * Creates a provider, seeded exactly as one created at boot would be.
   *
   * The two writes are one transaction on purpose. `seedDefaults` is what gives
   * a provider its settings and its copy of the equipment catalogue, and a
   * provider that exists without them does not fail loudly — it comes up with
   * no GenieACS address and with equipment detection that matches nothing, so
   * the panel merely looks broken to whoever was just handed it. Either both
   * happen or neither does.
   */
  static async create(req, res) {
    try {
      // Read exactly what was sent. `trim()` here would be the silent
      // normalisation the rule above exists to refuse.
      const slug = String(req.body?.slug ?? '');
      const name = String(req.body?.name ?? '').trim();

      const problem = slugProblem(slug);
      if (problem) {
        return res.status(400).json(createErrorResponse(problem));
      }
      if (name.length < 1 || name.length > NAME_MAX_LENGTH) {
        return res.status(400).json(
          createErrorResponse(`Name must be between 1 and ${NAME_MAX_LENGTH} characters`)
        );
      }
      if (await Tenant.findBySlug(slug)) {
        return res.status(409).json(createErrorResponse('Slug already taken'));
      }

      let id;
      try {
        await getDb().transaction(async (trx) => {
          id = await Tenant.create({ slug, name }, trx);
          // The whole-deployment pass, not a per-provider shortcut, and that is
          // the point: this is the same call the boot path makes, so a provider
          // minted at runtime is born through the code that mints one at boot
          // rather than through a second implementation that would drift from
          // it. It is idempotent — every provider that already has its settings
          // and a catalogue is skipped — so the cost is a handful of reads and
          // the guarantee is that there is only one way a provider comes into
          // existence.
          //
          // The transaction is passed rather than left to default to `getDb()`,
          // for the same reason `dbManagementService` passes the target of a
          // database switch: the new provider is not visible outside this
          // transaction yet, so seeding on another connection would not see it.
          await seedDefaults(trx);
        });
      } catch (error) {
        // Two writers racing on the same slug both pass the check above and one
        // loses on the unique index. Reading the table back tells the two apart
        // without having to recognise a constraint-violation error on three
        // different engines, and the loser gets the same 409 they would have
        // got a moment earlier.
        if (await Tenant.findBySlug(slug)) {
          return res.status(409).json(createErrorResponse('Slug already taken'));
        }
        throw error;
      }

      const created = await Tenant.findById(id);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_CREATED,
        tenant: created
      });
      const subscriptions = await subscriptionsByTenant();
      return res.status(201).json(createResponse('Tenant created successfully', {
        tenant: present(created, 0, subscriptions.get(Number(id)) || null)
      }));
    } catch (error) {
      console.error('Create tenant error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to create the provider', error.message)
      );
    }
  }

  /**
   * Suspends or reactivates a provider.
   *
   * `tenants.status` already means something everywhere in the panel:
   * `forEachTenant` visits only `active`, the media sweep walks past a
   * suspended provider, and the SGP webhook refuses a delivery for one. This
   * route does not invent that behaviour, it hands somebody the switch.
   *
   * Suspending is deliberately not a lockout: nothing in the sign-in path reads
   * this column, so a provider whose service has stopped can still be looked at
   * and, more importantly, turned back on.
   */
  static async setStatus(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const status = req.body?.status;
      if (!TENANT_STATUSES.includes(status)) {
        return res.status(400).json(
          createErrorResponse(`Status must be one of: ${TENANT_STATUSES.join(', ')}`)
        );
      }

      const tenant = await Tenant.findById(id);
      if (!tenant) {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }

      await Tenant.setStatus(id, status);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_STATUS_CHANGED,
        tenant,
        detail: { from: tenant.status, to: status }
      });
      // A linha nasce NO provedor suspenso, não numa trilha da plataforma: quem
      // vai perguntar "por que meu painel parou" é o ISP, e a resposta tem que
      // estar onde ele consegue olhar. `actorKind: 'platform'` é o que diz que
      // a mão veio de fora — sem isso a trilha mostraria a ação sem nenhum
      // operador daquele provedor por trás, e não haveria como distinguir de
      // uma linha com o ator perdido.
      await runInTenant(id, () => AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.TENANT_STATUS_CHANGED,
        actorKind: 'platform',
        subjectType: 'tenant',
        subjectId: id,
        detail: { from: tenant.status, to: status }
      }));
      const updated = await Tenant.findById(id);
      const counts = await Tenant.operatorCounts();
      const subscriptions = await subscriptionsByTenant();
      return res.json(createResponse('Tenant updated successfully', {
        tenant: present(updated, counts.get(Number(id)) || 0, subscriptions.get(Number(id)) || null)
      }));
    } catch (error) {
      console.error('Update tenant error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update the provider', error.message)
      );
    }
  }

  /**
   * Apaga um provedor e tudo o que é dele.
   *
   * As quatro condições estão no comentário do topo do arquivo. O que vale
   * dizer aqui é a ORDEM, que é a única parte com risco técnico: as tabelas
   * escopadas apontam para `tenants` sem cascata, então apagar de cima para
   * baixo falha na primeira chave estrangeira. Apaga-se na ordem INVERSA à de
   * criação do schema — a mesma lista que o export usa, lida de trás para
   * frente — e só então a linha do provedor.
   *
   * Tudo numa transação: um provedor meio apagado é pior que um inteiro, porque
   * o que sobra não aparece em tela nenhuma (a resolução por host já não o
   * encontra) e continua ocupando os índices únicos por provedor.
   */
  static async remove(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const tenant = await Tenant.findById(id);
      if (!tenant) {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }

      // Suspender primeiro é o que transforma isto em dois passos com um
      // estado reversível no meio. Um provedor ativo tem gente trabalhando
      // nele agora.
      if (tenant.status !== 'suspended') {
        return res.status(409).json(createErrorResponse(
          'Suspend the provider before deleting it'
        ));
      }
      // O slug digitado de volta, exato — sem normalizar caixa nem espaço. É a
      // confirmação inteira: normalizar aqui aceitaria um slug "quase certo",
      // que é justamente o que um engano parece.
      if (req.body?.confirmSlug !== tenant.slug) {
        return res.status(409).json(createErrorResponse(
          'Type the provider slug exactly to confirm the deletion'
        ));
      }
      // O último provedor não sai: sem nenhum, `resolveDefaultTenantId` devolve
      // null e o deployment inteiro passa a responder 503 — inclusive para quem
      // acabou de apagar, que perde a rota para desfazer.
      if ((await Tenant.list()).length <= 1) {
        return res.status(409).json(createErrorResponse(
          'The deployment must keep at least one provider'
        ));
      }

      const db = getDb();
      const escopadas = SCHEMA_TABLES.filter((tabela) => SCOPED_TABLES.has(tabela));
      const contagem = {};
      for (const tabela of escopadas) {
        const [linha] = await db(tabela).where({ tenant_id: id }).count({ n: '*' });
        contagem[tabela] = Number(linha?.n ?? 0);
      }
      const vinculos = await db('tenant_users').where({ tenant_id: id }).count({ n: '*' });
      contagem.tenant_users = Number(vinculos[0]?.n ?? 0);

      // ANTES de apagar, e conferido: aqui a trilha não é registro do que
      // houve, é condição para que aconteça.
      const registrada = await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.TENANT_DELETED,
        tenant,
        detail: { rowCounts: contagem }
      });
      if (!registrada) {
        return res.status(500).json(createErrorResponse(
          'The deletion was not recorded, so it was not performed'
        ));
      }

      await db.transaction(async (trx) => {
        // De trás para frente: as filhas antes das mães, que é o inverso da
        // ordem em que o schema as cria.
        for (const tabela of [...escopadas].reverse()) {
          await trx(tabela).where({ tenant_id: id }).del();
        }
        // `tenant_invites` já saiu no laço acima — ela é escopada, então está
        // em `escopadas`. `tenant_users` NÃO está: ela é do deploy, porque uma
        // linha ali é uma PESSOA que pode trabalhar para outro provedor. O que
        // se apaga aqui é o vínculo dela com este, e nunca a pessoa.
        await trx('tenant_users').where({ tenant_id: id }).del();
        await trx('tenants').where({ id }).del();
      });

      // O resolvedor guarda o id por slug e o primeiro provedor da tabela. Sem
      // isto, o processo continuaria resolvendo um provedor que não existe mais
      // até reiniciar — e o host dele responderia com o escopo de um fantasma.
      forgetResolvedTenant();

      return res.json(createResponse('Provider deleted successfully', {
        id, slug: tenant.slug, rowCounts: contagem
      }));
    } catch (error) {
      console.error('Delete tenant error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to delete the provider', error.message)
      );
    }
  }

  /** A trilha do plano de controle, da mais recente para a mais antiga. */
  static async listAudit(req, res) {
    try {
      const linhas = await PlatformAudit.list({
        limit: req.query?.limit,
        before: req.query?.before || null
      });
      return res.json(createResponse('Platform audit retrieved', {
        entries: linhas.map((linha) => ({
          id: linha.id,
          action: linha.action,
          actor: { userId: linha.actor_user_id, username: linha.actor_username },
          // Nome e slug vêm da linha e não de um join com `tenants`: o provedor
          // da linha mais importante desta tabela não existe mais.
          tenant: {
            id: linha.tenant_id,
            slug: linha.tenant_slug,
            name: linha.tenant_name
          },
          detail: linha.detail ? JSON.parse(linha.detail) : null,
          ip: linha.ip,
          at: linha.created_at
        })),
        nextBefore: linhas.length ? linhas[linhas.length - 1].id : null,
        actions: Object.values(PlatformAudit.ACTIONS)
      }));
    } catch (error) {
      console.error('List platform audit error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to read the platform audit', error.message)
      );
    }
  }
}

export default PlatformController;
