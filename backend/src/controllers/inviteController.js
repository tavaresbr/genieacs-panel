import bcrypt from 'bcryptjs';
import TenantInvite from '../models/TenantInvite.js';
import TenantUser from '../models/TenantUser.js';
import Tenant from '../models/Tenant.js';
import User from '../models/User.js';
import { getDb } from '../config/database.js';
import AuditLog from '../models/AuditLog.js';
import { ROLES, normalizeRole, roleHas } from '../config/permissions.js';
import { generateTokens } from '../middleware/auth.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

const BCRYPT_ROUNDS = 12;

/** Meia hora a trinta dias. Fora disso é engano de quem digitou, não escolha. */
const MIN_TTL_MS = 30 * 60 * 1000;
const MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * O que a tela de equipe pode ver de um convite. Nunca o token: ele não está
 * guardado, e se estivesse continuaria fora daqui.
 */
function publicInvite(invite) {
  return {
    id: invite.id,
    role: normalizeRole(invite.role),
    label: invite.label,
    expiresAt: invite.expires_at,
    createdAt: invite.created_at
  };
}

class InviteController {
  /** Os convites em aberto deste provedor. */
  static async list(req, res) {
    try {
      const invites = await TenantInvite.listOpen();
      return res.json(createResponse(req.t('invite.listed'), {
        invites: invites.map(publicInvite)
      }));
    } catch (error) {
      console.error('List invites error:', error);
      return res.status(500).json(createErrorResponse(req.t('invite.listFailed'), error.message));
    }
  }

  /**
   * Cria o convite e devolve o token UMA vez.
   *
   * O painel não manda e-mail — não há transporte de correio em lugar nenhum
   * deste produto — então quem entrega o link é quem convidou, pelo canal que
   * já usa com aquela pessoa. É de propósito que a rota devolva o link em vez
   * de prometer um envio: um convite que o produto diz ter mandado e não mandou
   * é pior que um convite que ele entrega na mão.
   */
  static async create(req, res) {
    try {
      const role = normalizeRole(req.body?.role);
      if (!ROLES.includes(req.body?.role)) {
        return res.status(400).json(
          createErrorResponse(req.t('invite.roleInvalid', { roles: ROLES.join(', ') }))
        );
      }
      // Mesma regra do PATCH em `/api/users`: quem não é `owner` não cunha um.
      // Sem isto o convite seria a porta dos fundos da promoção — um `admin`
      // convidaria a si mesmo de volta como `owner` e a distinção entre os dois
      // papéis não existiria de fato.
      if (role === 'owner' && normalizeRole(req.user?.role) !== 'owner') {
        return res.status(403).json(createErrorResponse(req.t('invite.ownerOnly')));
      }

      const ttlMs = req.body?.ttlMs === undefined
        ? TenantInvite.DEFAULT_TTL_MS
        : Number(req.body.ttlMs);
      if (!Number.isFinite(ttlMs) || ttlMs < MIN_TTL_MS || ttlMs > MAX_TTL_MS) {
        return res.status(400).json(createErrorResponse(req.t('invite.ttlInvalid')));
      }

      const { invite, token } = await TenantInvite.create({
        role,
        label: req.body?.label,
        createdBy: req.user?.userId ?? null,
        ttlMs
      });

      // O token NÃO entra na trilha. Ele é uma credencial: quem tem o link
      // entra na equipe com o papel escrito nele, e guardá-lo aqui faria da
      // trilha uma lista de convites utilizáveis.
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.INVITE_CREATED,
        subjectType: 'invite',
        subjectId: invite.id,
        detail: { role, label: invite.label, expiresAt: invite.expires_at }
      });
      return res.status(201).json(createResponse(req.t('invite.created'), {
        invite: publicInvite(invite),
        // Mostrado uma vez, como o segredo do webhook do SGP e a senha do portal
        // do assinante: a tabela guarda o hash, então nem esta rota nem
        // nenhuma outra consegue dizer isto de novo.
        token
      }));
    } catch (error) {
      console.error('Create invite error:', error);
      return res.status(500).json(createErrorResponse(req.t('invite.createFailed'), error.message));
    }
  }

  /** Revoga um convite ainda aberto. */
  static async revoke(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(404).json(createErrorResponse(req.t('invite.notFound')));
      }
      // 404 e não 403 para o convite de outro provedor: `TenantInvite.revoke`
      // passa por `tdb`, então a linha do vizinho não é proibida, ela não
      // existe. Um 403 confirmaria que aquele id é um convite de alguém.
      if (!await TenantInvite.revoke(id)) {
        return res.status(404).json(createErrorResponse(req.t('invite.notFound')));
      }
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.INVITE_REVOKED,
        subjectType: 'invite',
        subjectId: id
      });
      return res.json(createResponse(req.t('invite.revoked'), { id }));
    } catch (error) {
      console.error('Revoke invite error:', error);
      return res.status(500).json(createErrorResponse(req.t('invite.revokeFailed'), error.message));
    }
  }

  /**
   * O que quem abriu o link vê antes de decidir.
   *
   * Sem sessão: é a tela de "você foi convidado para o Provedor X como
   * técnico". Devolve o nome público do provedor — as duas colunas que
   * `Tenant.PUBLIC_COLUMNS` permite — e o papel oferecido, e nada mais.
   *
   * **Uma resposta só para os cinco jeitos de um convite não servir**: token que
   * nunca existiu, expirado, já aceito, revogado, ou de outro provedor que não
   * o do host. Todos 404, com o mesmo corpo. Separá-los transformaria o link num
   * oráculo — "este token existiu", "este provedor tem convite em aberto" — para
   * quem tem exatamente zero credenciais, que é a pior audiência possível.
   */
  static async preview(req, res) {
    try {
      const invite = await InviteController.usableInvite(req);
      if (!invite) return res.status(404).json(createErrorResponse(req.t('invite.notFound')));

      const tenant = await Tenant.findPublicById(invite.tenant_id);
      if (!tenant) return res.status(404).json(createErrorResponse(req.t('invite.notFound')));

      return res.json(createResponse(req.t('invite.previewed'), {
        tenant: { name: tenant.name, slug: tenant.slug },
        role: normalizeRole(invite.role)
      }));
    } catch (error) {
      console.error('Preview invite error:', error);
      return res.status(500).json(createErrorResponse(req.t('invite.previewFailed'), error.message));
    }
  }

  /**
   * Aceitar: entra na equipe, com a conta que já existe ou com uma nova.
   *
   * Os dois caminhos, e por que os dois têm que existir:
   *
   * - **Com senha da conta que já tem** (`username` + `password`): é o
   *   consultor que atende dois ISPs. Ninguém aqui escolhe a senha dele — ele
   *   prova quem é com a que já usa, e é essa prova que a onda 12 exigia e que
   *   o endpoint de criação não conseguia dar.
   * - **Conta nova** (`username` + `password` de alguém que não existe): a
   *   pessoa escolhe a própria senha. O administrador que convidou nunca a vê,
   *   que é a diferença inteira entre isto e `POST /api/users`.
   *
   * O mesmo corpo serve aos dois porque, do lado de quem preenche, é a mesma
   * tela: nome e senha. Quem decide qual caminho é o banco, e não um campo que
   * a pessoa teria de marcar sabendo de antemão se já existe no deploy.
   */
  static async accept(req, res) {
    try {
      const invite = await InviteController.usableInvite(req);
      if (!invite) return res.status(404).json(createErrorResponse(req.t('invite.notFound')));

      const username = String(req.body?.username ?? '').trim();
      const password = String(req.body?.password ?? '');
      if (username.length < 3 || username.length > 64) {
        return res.status(400).json(createErrorResponse(req.t('auth.usernameLength')));
      }
      if (password.length < 8 || password.length > 128) {
        return res.status(400).json(createErrorResponse(req.t('auth.passwordLength')));
      }

      const role = normalizeRole(invite.role);
      const existente = await User.findByUsername(username);
      let userId;

      if (existente) {
        // A senha é a prova de que é ela mesma. Sem esta conferência o convite
        // seria uma tomada de conta: quem tivesse o link digitaria o nome de
        // qualquer pessoa do deploy e a anexaria a este provedor sem que ela
        // soubesse — e o papel viria junto.
        if (!await bcrypt.compare(password, existente.password)) {
          return res.status(401).json(createErrorResponse(req.t('auth.invalidCredentials')));
        }
        // Já trabalha aqui: o convite não some e não vira erro. É o caso do
        // link clicado duas vezes, e a resposta certa para "me põe na equipe"
        // de quem já está na equipe é "pronto".
        if (await TenantUser.find(invite.tenant_id, existente.id)) {
          return res.status(409).json(createErrorResponse(req.t('invite.alreadyMember')));
        }
        userId = existente.id;
      }

      const trx = await getDb().transaction();
      try {
        if (!existente) {
          userId = await User.create({
            username,
            password: await bcrypt.hash(password, BCRYPT_ROUNDS),
            role
          }, trx);
        }
        // O consumo vai ANTES do vínculo e dentro da mesma transação. O UPDATE
        // condicional é o que torna o convite de uso único: dois cliques
        // simultâneos chegam aqui juntos, e o segundo recebe `false` do banco
        // em vez de passar por um `if` que os dois já haviam lido como aberto.
        if (!await TenantInvite.markAccepted(
          { id: invite.id, tenantId: invite.tenant_id }, userId, trx
        )) {
          await trx.rollback();
          return res.status(404).json(createErrorResponse(req.t('invite.notFound')));
        }
        await TenantUser.create({ tenantId: invite.tenant_id, userId, role }, trx);
        await trx.commit();
      } catch (error) {
        await trx.rollback();
        throw error;
      }

      // Entra já logada, no provedor do convite. A alternativa — devolver
      // "pronto, agora faça login" — mandaria a pessoa para uma tela de login
      // que ela nunca viu, num endereço que ela acabou de conhecer.
      const user = await User.findById(userId);
      const membership = await TenantUser.find(invite.tenant_id, userId);

      // Ator preenchido à mão, e não por `fromRequest`: quem aceita não tinha
      // sessão quando o request chegou, então `req.user` está vazio. O ator é a
      // pessoa que acabou de entrar — que é exatamente quem a trilha precisa
      // nomear aqui. O escopo é o do host, e `usableInvite` já conferiu que ele
      // é o do convite, então a linha nasce no provedor certo.
      await AuditLog.record({
        action: AuditLog.ACTIONS.INVITE_ACCEPTED,
        actorUserId: userId,
        actorUsername: user.username,
        subjectType: 'invite',
        subjectId: invite.id,
        detail: { role, createdNewAccount: !existente },
        ip: req.ip ?? null
      });

      const { accessToken, refreshToken } = generateTokens(user, membership);

      return res.status(201).json(createResponse(req.t('invite.accepted'), {
        user: {
          id: user.id,
          username: user.username,
          role: membership.role,
          tenantId: Number(membership.tenant_id),
          isPlatformAdmin: false,
          createdAt: user.created_at,
          updatedAt: user.updated_at
        },
        token: accessToken,
        refreshToken
      }));
    } catch (error) {
      console.error('Accept invite error:', error);
      return res.status(500).json(createErrorResponse(req.t('invite.acceptFailed'), error.message));
    }
  }

  /**
   * O convite que o token nomeia, se ele servir para ESTE host.
   *
   * A conferência contra `req.tenantId` é o que impede um convite do provedor A
   * de ser usado no endereço do provedor B. Sem ela o vínculo seria criado com
   * o `tenant_id` do convite — o certo — mas a pessoa teria entrado por uma
   * porta que não é a dela, e num deploy com subdomínio isso é o começo de uma
   * sessão no host errado. Como todas as outras recusas daqui, responde null e
   * vira o mesmo 404.
   */
  static async usableInvite(req) {
    const invite = await TenantInvite.findByToken(req.params?.token);
    if (!TenantInvite.isOpen(invite)) return null;
    if (Number(invite.tenant_id) !== Number(req.tenantId)) return null;
    return invite;
  }
}

export { publicInvite };
export default InviteController;
