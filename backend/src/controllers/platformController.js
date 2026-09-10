import Tenant from '../models/Tenant.js';
import PlatformAudit from '../models/PlatformAudit.js';
import TenantSubscription from '../models/TenantSubscription.js';
import TenantBillingEvent from '../models/TenantBillingEvent.js';
import SubscriptionBillingService from '../services/subscriptionBillingService.js';
import { SUBSCRIPTION_STATUSES } from '../config/subscription.js';
import { SCHEMA_TABLES } from '../config/migrations.js';
import { SCOPED_TABLES } from '../config/tenantScope.js';
import { forgetResolvedTenant } from '../middleware/tenantResolver.js';
import AuditLog from '../models/AuditLog.js';
import { runInTenant } from '../config/tenantContext.js';
import { getDb } from '../config/database.js';
import { seedDefaults } from '../config/seed.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

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
 * The slug is the subdomain the panel will be reached at, so the rule is DNS's
 * rule and not a taste in identifiers:
 *
 *   - lowercase ASCII letters, digits and hyphens only;
 *   - first and last character alphanumeric, so no leading or trailing hyphen;
 *   - 3 to 63 characters, 63 being the maximum length of a DNS label.
 *
 * Uppercase is REJECTED rather than lowered, and a stray space rejected rather
 * than trimmed, because whoever creates the provider is about to tell an ISP
 * the address of their panel. A slug that is silently rewritten means the
 * address they were given is not the address they typed, and they find that out
 * from a browser that cannot resolve it. Refusing costs one retry and says
 * exactly what is wrong.
 */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_MIN_LENGTH = 3;
const SLUG_MAX_LENGTH = 63;

/**
 * Labels that cannot become a provider, because the deployment already answers
 * to them. Handing an ISP `www.panel.example` or `api.panel.example` would put
 * their panel where the marketing site or the API lives — a collision nobody
 * can fix afterwards without moving that ISP to a new address.
 */
const RESERVED_SLUGS = new Set([
  'www', 'api', 'app', 'admin', 'portal', 'mail', 'static', 'assets', 'cdn', 'status'
]);

const NAME_MAX_LENGTH = 128;

/** What is wrong with this slug, or null when nothing is. */
function slugProblem(slug) {
  if (slug.length < SLUG_MIN_LENGTH || slug.length > SLUG_MAX_LENGTH) {
    return `Slug must be between ${SLUG_MIN_LENGTH} and ${SLUG_MAX_LENGTH} characters`;
  }
  if (!SLUG_PATTERN.test(slug)) {
    return 'Slug must be lowercase letters, digits and hyphens, starting and ending with a letter or digit';
  }
  // A hyphen in the third and fourth position is reserved by RFC 5891: `xn--`
  // introduces a punycode label, and every other pair is held back for whatever
  // comes next. A resolver is entitled to read such a label as encoded.
  if (slug[2] === '-' && slug[3] === '-') {
    return 'Slug must not carry a hyphen in both the third and fourth position';
  }
  if (RESERVED_SLUGS.has(slug)) {
    return 'Slug is reserved by the deployment';
  }
  return null;
}

/** The provider as the console shows it: `operators` is how many people work there. */
function present(tenant, operators, subscription = null) {
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    // O eixo comercial vem ao lado do administrativo, e não no lugar dele: as
    // duas perguntas que o console precisa responder são "este provedor está
    // congelado?" e "este provedor está pagando?", e são independentes.
    subscription: TenantSubscription.present(subscription),
    operators,
    createdAt: tenant.created_at ?? null
  };
}

class PlatformController {
  static async listTenants(req, res) {
    try {
      const tenants = await Tenant.list();
      const counts = await Tenant.operatorCounts();
      const assinaturas = await TenantSubscription.byTenantIds(tenants.map((t) => t.id));
      return res.json(createResponse('Tenants retrieved successfully', {
        tenants: tenants.map((tenant) => present(
          tenant,
          counts.get(Number(tenant.id)) || 0,
          assinaturas.get(Number(tenant.id)) ?? null
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
        // Fora da transação de propósito: `TenantSubscription.createFor` usa a
        // conexão padrão, e o provedor só existe para ela depois do commit.
        // Pôr a criação lá dentro exigiria passar a transação por mais uma
        // camada para ganhar nada — se esta escrita falhar, o provedor fica sem
        // linha, e um provedor sem linha PASSA no portão. A falha erra para o
        // lado de um cliente que trabalha, que é o lado certo (ver o portão).
        await TenantSubscription.createFor(id, {
          reason: 'Provedor criado pelo plano de controle'
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
      return res.status(201).json(createResponse('Tenant created successfully', {
        tenant: present(created, 0, await TenantSubscription.findByTenantId(id))
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
   * Suspender TRANCA, e a frase que estava aqui dizia o contrário — «nada no
   * caminho de login lê esta coluna». Lê: `resolveTenantIdBySlug` devolve nulo
   * para quem não está `active`, o que faz o painel E o portal do provedor
   * suspenso responderem 404. A frase só era verdadeira na instalação de um
   * provedor só, onde a resolução cai em `resolveDefaultTenantId`, que
   * realmente não olha o status — e é a instalação onde esta rota nem existe.
   * O `forgetResolvedTenant()` logo abaixo é a prova de que o trancamento é
   * real: ele existe porque, sem invalidar o cache, a suspensão só passaria a
   * valer no próximo restart.
   *
   * É por isso que a inadimplência NÃO escreve aqui. `tenants.status` é o eixo
   * administrativo — congelar para poder apagar, e apagar de vez —, e um boleto
   * atrasado que caísse nesta coluna tornaria o cliente elegível à exclusão em
   * duas etapas e derrubaria o portal dos assinantes dele junto. O eixo
   * comercial é `tenant_subscriptions`, tem rota própria logo abaixo, e um
   * portão que distingue ler de escrever.
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
      // O resolvedor guarda slug -> id pela vida do processo e não relê o
      // status, então sem isto uma suspensão só passa a valer no próximo
      // restart: o painel e o portal do provedor suspenso seguem servindo e
      // ainda autenticando gente nova, enquanto os jobs de fundo — que leem a
      // coluna — param. Pior, a exclusão em duas etapas confia na suspensão
      // para significar "ninguém está trabalhando lá dentro".
      forgetResolvedTenant();
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
      return res.json(createResponse('Tenant updated successfully', {
        tenant: present(
          updated,
          counts.get(Number(id)) || 0,
          await TenantSubscription.findByTenantId(id)
        )
      }));
    } catch (error) {
      console.error('Update tenant error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update the provider', error.message)
      );
    }
  }

  /**
   * Muda o estado COMERCIAL de um provedor.
   *
   * Irmã de `setStatus`, e separada dela porque as duas colunas significam
   * coisas diferentes. `tenants.status` congela o provedor e é pré-requisito da
   * exclusão; esta diz se a fatura está em dia. Uma rota só, com um campo
   * `status` ambíguo, seria a próxima pessoa suspendendo comercialmente um
   * cliente e, sem querer, tornando-o elegível para ser apagado.
   *
   * O que ela NÃO faz: invalidar o cache do resolvedor. Aquele cache guarda
   * slug -> id e é o `tenants.status` que ele lê; o portão comercial consulta a
   * tabela a cada requisição, então a mudança daqui vale na requisição
   * seguinte, sem restart e sem invalidação.
   */
  static async setSubscriptionStatus(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const status = req.body?.status;
      if (!SUBSCRIPTION_STATUSES.includes(status)) {
        return res.status(400).json(
          createErrorResponse(`Status must be one of: ${SUBSCRIPTION_STATUSES.join(', ')}`)
        );
      }
      const motivo = req.body?.reason === undefined || req.body?.reason === null
        ? null
        : String(req.body.reason).trim().slice(0, 255) || null;

      const tenant = await Tenant.findById(id);
      if (!tenant) {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }

      const mudanca = await TenantSubscription.setStatus(id, status, { reason: motivo });
      // Sem linha não há o que mudar, e criar uma aqui seria esta rota
      // inventando uma assinatura que ninguém contratou.
      if (!mudanca) {
        return res.status(404).json(createErrorResponse('Provider has no subscription'));
      }

      // Duas escritas, e não uma repetida. A trilha registra o ATO e quem o
      // praticou — prestação de contas. O extrato registra o FATO comercial, e
      // é o que faz a história ficar legível em ordem: pagou, atrasou,
      // suspendemos, pagou. Um webhook de gateway vai escrever no extrato sem
      // ter ator nenhum para a trilha.
      await SubscriptionBillingService.recordStatusChange({
        tenantId: id, from: mudanca.from, to: mudanca.to, reason: motivo
      });
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.SUBSCRIPTION_CHANGED,
        tenant,
        detail: { from: mudanca.from, to: mudanca.to, reason: motivo }
      });
      // E a mesma linha DENTRO do provedor, pelo motivo de sempre: quem vai
      // perguntar "por que meu painel ficou somente leitura" é o ISP, e a
      // resposta tem que estar onde ele consegue olhar.
      await runInTenant(id, () => AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.SUBSCRIPTION_CHANGED,
        actorKind: 'platform',
        subjectType: 'tenant',
        subjectId: id,
        detail: { from: mudanca.from, to: mudanca.to, reason: motivo }
      }));

      const counts = await Tenant.operatorCounts();
      return res.json(createResponse('Subscription updated successfully', {
        tenant: present(
          tenant,
          counts.get(Number(id)) || 0,
          await TenantSubscription.findByTenantId(id)
        )
      }));
    } catch (error) {
      console.error('Update subscription error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to update the subscription', error.message)
      );
    }
  }

  /**
   * Marca pago: `POST /api/platform/tenants/:id/billing`.
   *
   * O caminho por onde um gateway vai entrar sem que nada aqui mude. Hoje quem
   * chama somos nós, pelo console; amanhã é o webhook do Asaas, com o
   * `externalId` dele — e é esse campo que impede uma reentrega de empurrar o
   * período mais trinta dias.
   */
  static async recordPayment(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      const tenant = await Tenant.findById(id);
      if (!tenant) {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }

      const centavos = req.body?.amountCents;
      if (centavos !== undefined && centavos !== null) {
        const n = Number(centavos);
        // Zero é legítimo — uma cortesia, um período de teste estendido —, mas
        // negativo não: um estorno é um fato próprio, não um pagamento com
        // sinal trocado, e aceitá-lo aqui faria a soma do extrato mentir.
        if (!Number.isInteger(n) || n < 0) {
          return res.status(400).json(createErrorResponse('amountCents must be a non-negative integer'));
        }
      }
      const provider = SubscriptionBillingService.providerFor(req.body?.source);
      if (!provider) {
        return res.status(400).json(createErrorResponse('Unknown billing provider'));
      }

      const resultado = await provider.applyPayment({
        tenantId: id,
        amountCents: centavos ?? null,
        currency: String(req.body?.currency ?? 'BRL').slice(0, 3).toUpperCase(),
        externalId: req.body?.externalId ? String(req.body.externalId).slice(0, 128) : null,
        detail: req.body?.reason ? { reason: String(req.body.reason).slice(0, 255) } : null
      });
      if (!resultado.applied && !resultado.duplicate) {
        return res.status(404).json(createErrorResponse('Provider has no subscription'));
      }

      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.SUBSCRIPTION_CHANGED,
        tenant,
        detail: {
          payment: true,
          duplicate: Boolean(resultado.duplicate),
          amountCents: centavos ?? null
        }
      });

      const counts = await Tenant.operatorCounts();
      // 200 e não 201 numa reentrega: nada foi criado, e o gateway que reenviou
      // precisa de uma resposta de sucesso para parar de tentar.
      return res.status(resultado.duplicate ? 200 : 201).json(
        createResponse(resultado.duplicate ? 'Payment already recorded' : 'Payment recorded', {
          duplicate: Boolean(resultado.duplicate),
          event: TenantBillingEvent.present(resultado.event),
          tenant: present(
            tenant,
            counts.get(Number(id)) || 0,
            await TenantSubscription.findByTenantId(id)
          )
        })
      );
    } catch (error) {
      console.error('Record payment error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to record the payment', error.message)
      );
    }
  }

  /** O extrato de um provedor: `GET /api/platform/tenants/:id/billing`. */
  static async listBilling(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      if (!await Tenant.findById(id)) {
        return res.status(404).json(createErrorResponse('Provider not found'));
      }
      // No escopo do provedor consultado, e não no do host do console: é a
      // leitura escopada normal, e é o que faz o extrato de um não poder sair
      // pela pergunta sobre o outro.
      const eventos = await runInTenant(id, () => TenantBillingEvent.list({
        limit: req.query?.limit
      }));
      return res.json(createResponse('Billing events retrieved', {
        events: eventos.map((linha) => TenantBillingEvent.present(linha))
      }));
    } catch (error) {
      console.error('List billing error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to read the billing events', error.message)
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
