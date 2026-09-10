import { getDb } from '../config/database.js';
import TenantUser from '../models/TenantUser.js';
import User from '../models/User.js';
import AuditLog from '../models/AuditLog.js';
import PlatformAudit from '../models/PlatformAudit.js';
import { runInTenant } from '../config/tenantContext.js';
import { ROLES } from './usersController.js';
import { normalizeRole, roleHas } from '../config/permissions.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

/**
 * Who works for a provider, decided from the control plane.
 *
 * `/api/users` answers the same question from INSIDE one provider, and the
 * difference between the two is the whole reason this file exists. Wave 12
 * refused to let a provider's own administrator attach a person who already
 * exists on the deployment: that request carries a password, there is one
 * password per person, so "attach maria" would reset the login of a stranger
 * who works for somebody else, sign her out everywhere, and hand the caller
 * working credentials at another ISP — from guessing a username.
 *
 * A platform administrator is a different trust level: they can already mint
 * providers, so reaching between them is not an escalation. They are therefore
 * who attaches an existing person to a provider — and the operation here NEVER
 * touches the password. It writes a membership and nothing else. That is not an
 * omission to be filled in later: a password field on this route would recreate
 * exactly the hazard wave 12 refused, one plane up, where it would be worse.
 *
 * Every route below names its provider in the path rather than reading
 * `req.tenantId`. The scope a platform administrator's own session runs in is
 * whichever provider they happen to work for, and it has nothing to do with the
 * provider they are administering. `tenant_users`, `users` and `tenants` are
 * all shared tables read through `getDb()` rather than `tdb`, so naming the
 * provider in the path is not fighting the scope — it is the only thing that
 * decides which provider these routes act on.
 *
 * E é por isso que attach e detach gravam DUAS trilhas, como a suspensão em
 * `platformController.setStatus` já grava. Um vínculo escrito daqui vira uma
 * sessão legítima dentro de um ISP — cadastro inteiro, senhas de portal,
 * exportação — e escrever só em `platform_audit` deixaria a única cópia do
 * registro na trilha de quem agiu, que é a trilha que o ISP não pode ler. A
 * linha espelhada no `audit_log` DAQUELE provedor, com `actorKind: 'platform'`,
 * é o que permite ao ISP ver que uma mão de fora mexeu na equipe dele. Nenhuma
 * das duas é condição da ação: o vínculo já foi escrito quando elas falham, e
 * derrubar a resposta ali só produziria uma segunda tentativa — a exceção que
 * confere o retorno é a exclusão de provedor, onde a trilha é condição.
 */

/**
 * O papel tal como vale. Mesma função que `/api/users` usa, e importada da
 * matriz em vez de repetida: o plano de controle não pode reportar para uma
 * linha um papel que a tela do próprio provedor soletra de outro jeito, e duas
 * cópias da regra divergem no primeiro papel novo.
 */
const presentRole = normalizeRole;

/** Os papéis que administram a equipe, derivados da matriz — ver `usersController`. */
const ADMINISTRADORES = ROLES.filter((role) => roleHas(role, 'operators.manage'));

/** The `TenantMembership` the panel's API contract asks for. */
function present(member) {
  return {
    userId: member.id,
    username: member.username,
    role: presentRole(member.role)
  };
}

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * The provider named in the path, or null.
 *
 * Read straight from `tenants` rather than through a model: there is none yet,
 * and this is a single existence check. It is here so that a bad id answers 404
 * instead of writing a membership at a provider that is not there — the foreign
 * key would catch it, but as a 500 with a driver's words in it.
 */
async function findTenant(id) {
  return (await getDb()('tenants').where({ id }).first()) || null;
}

/**
 * A provider that does not exist says so, plainly.
 *
 * `/api/users` answers 404 for somebody who works elsewhere precisely so that a
 * prober cannot map the deployment. Here that reasoning is inverted: listing
 * every provider is this caller's own first screen, so hiding which ids exist
 * from them would protect nothing and would turn a mistyped id into a silent
 * empty team.
 */
function tenantNotFound(res) {
  return res.status(404).json(createErrorResponse('Provider not found'));
}

class PlatformMemberController {
  /** Everyone who works for one provider, with the role they hold THERE. */
  static async list(req, res) {
    try {
      const tenantId = parseId(req.params?.id);
      if (!tenantId) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      if (!(await findTenant(tenantId))) return tenantNotFound(res);

      const members = await TenantUser.listForTenant(tenantId);
      return res.json(createResponse('Memberships retrieved successfully', {
        memberships: members.map(present)
      }));
    } catch (error) {
      console.error('List memberships error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to list the provider members', error.message)
      );
    }
  }

  /**
   * Attaches a person who already exists to a provider.
   *
   * The person must already exist. Creating one is `/api/users`' job, at a
   * provider, where the request carries a password chosen by whoever typed it
   * — and this route has no password field by design. Creating from here would
   * have to invent one of two bad things: an account whose password the
   * platform administrator knows, or an account with no usable password that
   * nobody can sign in to. So an unknown username is refused and says so: this
   * caller is trusted with the whole deployment, and hiding from them which
   * usernames exist would only make the screen unusable.
   */
  static async add(req, res) {
    try {
      const tenantId = parseId(req.params?.id);
      if (!tenantId) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      // A linha do provedor, e não só a confirmação de que ele existe: o slug e
      // o nome vão para a trilha da plataforma junto com o id, como em toda
      // linha daquela tabela, para que ela siga legível quando o provedor não
      // existir mais.
      const tenant = await findTenant(tenantId);
      if (!tenant) return tenantNotFound(res);

      const username = String(req.body?.username ?? '').trim();
      const role = req.body?.role;
      if (!username) {
        return res.status(400).json(createErrorResponse('Username is required'));
      }
      // The same vocabulary `/api/users` writes, imported rather than repeated:
      // a membership role written here is read by that screen, and two lists
      // that drifted apart would let the control plane write a role the
      // provider's own team screen cannot display.
      if (!ROLES.includes(role)) {
        return res.status(400).json(
          createErrorResponse(`Role must be one of: ${ROLES.join(', ')}`)
        );
      }

      // Nome OU e-mail: o plano de controle anexa uma pessoa que já existe, e
      // depois desta versão ela é conhecida pelo endereço tanto quanto pelo
      // nome. Procurar só pelo nome faria a rota não achar quem já migrou.
      const person = await User.findByLogin(username);
      if (!person) {
        return res.status(404).json(createErrorResponse('No such person on this deployment'));
      }
      // Refused rather than written twice. `tenant_users` is unique on
      // (tenant_id, user_id), so the second insert would fail on the
      // constraint; catching it here is the difference between "she already
      // works here" on screen and a 500 carrying a driver's message. Changing
      // the role of a membership that exists is the provider's own decision,
      // through `/api/users`, and doing it silently from this route would let
      // the control plane demote an ISP's administrator through a call that
      // reads as "add".
      if (await TenantUser.find(tenantId, person.id)) {
        return res.status(409).json(
          createErrorResponse('This person already works for this provider')
        );
      }

      // The one write. No `users` row is touched: not the password, not the
      // deployment-wide role, not `token_version`. The person's open sessions
      // stay valid because nothing about them changed — a new membership takes
      // effect when they sign in and choose this provider, and revoking here
      // would sign them out of the ISP they are working at right now to tell
      // them about a job they have just been given.
      await TenantUser.create({ tenantId, userId: person.id, role });

      // Quem agiu, em qual provedor, quem foi vinculado e com que papel. O
      // `detail` não carrega nada da pessoa além do nome e do id: a senha não
      // passa por esta rota e o hash não tem por que aparecer numa trilha.
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.MEMBER_ADDED,
        tenant,
        detail: { userId: person.id, username: person.username, role }
      });
      // A mesma ação, na trilha do provedor afetado — `runInTenant` porque
      // `audit_log` é escopada e o escopo aberto por `authenticateToken` é o do
      // provedor em que o administrador da plataforma trabalha, que não é este.
      // A ação reaproveita o vocabulário que a tela de trilha do provedor já
      // lê; o que diz que a mão veio de fora é `actorKind: 'platform'`.
      await runInTenant(tenantId, () => AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.OPERATOR_CREATED,
        actorKind: 'platform',
        subjectType: 'tenant_user',
        subjectId: person.id,
        detail: { username: person.username, role }
      }));

      return res.status(201).json(createResponse('Membership created successfully', {
        membership: present({ ...person, role })
      }));
    } catch (error) {
      console.error('Add membership error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to attach the person to the provider', error.message)
      );
    }
  }

  /**
   * Ends the membership. The person stays, always.
   *
   * They may work for another provider, and their name is on history that
   * points at `users.id` — who sent that message, who revoked that opt-out, who
   * created that campaign. Those three foreign keys are ON DELETE SET NULL, so
   * deleting the person would not fail loudly: it would quietly blank the
   * record of who did what, at every provider they ever worked for.
   */
  static async remove(req, res) {
    try {
      const tenantId = parseId(req.params?.id);
      const userId = parseId(req.params?.userId);
      if (!tenantId) {
        return res.status(400).json(createErrorResponse('Invalid provider id'));
      }
      if (!userId) {
        return res.status(400).json(createErrorResponse('Invalid operator id'));
      }
      const tenant = await findTenant(tenantId);
      if (!tenant) return tenantNotFound(res);

      const membership = await TenantUser.find(tenantId, userId);
      if (!membership) {
        return res.status(404).json(createErrorResponse('Membership not found'));
      }

      // The membership this session is running on. Ending it would 403 the
      // caller's very next request — `authenticateToken` re-reads the row on
      // every call — so the control-plane screen would appear to break at the
      // moment it succeeded. A platform administrator who really means to leave
      // a provider can do it from a session at another one; refusing costs them
      // that, and saves everyone else an unexplained logout.
      if (userId === req.user.userId && tenantId === req.user.tenantId) {
        return res.status(409).json(
          createErrorResponse('You cannot end the membership your own session runs on')
        );
      }

      // The last administrator of a provider, removed by somebody who does not
      // work there.
      //
      // `/api/users` refuses this, and so does this route, but not for the same
      // reason. There the argument is that nobody left inside the provider
      // could undo it. Here that argument does not hold: the caller holds the
      // repair tool, and one POST to this same route puts an administrator
      // back. The reason it is still refused is that the panel already HAS an
      // operation for taking a provider out of service — `tenants.status`,
      // which `forEachTenant`, the media sweep and the SGP webhook all honour,
      // and which is recorded on the provider and reversible in one click.
      // Stripping the last administrator reaches a state that looks the same to
      // the ISP's staff (nobody can manage anything) while the control plane's
      // own provider list still shows it active, so nothing on any screen says
      // why the phone is ringing. Two ways to disable a provider, one of them
      // invisible, is worth more than the ability to do staff churn in any
      // order: the platform administrator attaches the replacement first, and
      // then removes the outgoing one.
      //
      // Note what is counted: administrators OF THIS PROVIDER. Counting across
      // the deployment — as the guard did before `tenant_users` existed — would
      // be wrong in both directions at once, letting another ISP's admins
      // authorise emptying this one.
      if (roleHas(membership.role, 'operators.manage')
        && await TenantUser.countByRoles(tenantId, ADMINISTRADORES) <= 1) {
        return res.status(409).json(
          createErrorResponse('A provider must keep at least one administrator')
        );
      }

      // Lido ANTES da remoção porque é o nome que as duas trilhas vão registrar
      // — o id sozinho não diz a ninguém quem saiu, e daqui a um ano pode não
      // haver mais a quem perguntar. A pessoa sobrevive à remoção, então isto é
      // conveniência de leitura e não uma corrida.
      const person = await User.findById(userId);
      const role = presentRole(membership.role);

      await TenantUser.remove(tenantId, userId);

      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.MEMBER_REMOVED,
        tenant,
        detail: { userId, username: person?.username ?? null, role }
      });
      // E no provedor que perdeu a pessoa, pelo mesmo motivo da suspensão: quem
      // vai perguntar "cadê o fulano da minha equipe" é o ISP, e a resposta tem
      // que estar onde ele consegue olhar.
      await runInTenant(tenantId, () => AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.OPERATOR_REMOVED,
        actorKind: 'platform',
        subjectType: 'tenant_user',
        subjectId: userId,
        detail: { username: person?.username ?? null, role }
      }));

      // Deliberately no session revocation, which is where this parts company
      // with `/api/users`. `token_version` lives on the PERSON, so bumping it
      // signs them out of every provider they work for, and this operation is
      // about one. It is not needed for safety either: the membership is read
      // back from the table on every authenticated request, so the session that
      // named this provider stops working at its next call regardless — while
      // the shift they may be working at another ISP carries on, which is the
      // only difference the bump would have made.
      return res.json(createResponse('Membership ended successfully', { userId }));
    } catch (error) {
      console.error('Remove membership error:', error);
      return res.status(500).json(
        createErrorResponse('Failed to end the membership', error.message)
      );
    }
  }
}

export default PlatformMemberController;
