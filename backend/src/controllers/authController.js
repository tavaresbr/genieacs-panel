import bcrypt from 'bcryptjs';
import ImpersonationTicket from '../models/ImpersonationTicket.js';
import AuthTicket from '../models/AuthTicket.js';
import PlatformAdmin from '../models/PlatformAdmin.js';
import User from '../models/User.js';
import { acceptsIdentifier, canHoldSession, LOGIN_REQUIRES_EMAIL } from '../config/login.js';
import TenantUser from '../models/TenantUser.js';
import { IS_SAAS } from '../config/edition.js';
import { generateImpersonationToken, generateTokens, resolveMembership, verifyToken } from '../middleware/auth.js';
import { createResponse, createErrorResponse, isValidEmail } from '../utils/helpers.js';
import Tenant from '../models/Tenant.js';
import PlatformAudit from '../models/PlatformAudit.js';
import { getDb } from '../config/database.js';
import { seedDefaults } from '../config/seed.js';
import { slugProblem } from '../utils/slug.js';
import { panelBaseDomain, usesTenantSubdomains } from '../middleware/tenantResolver.js';
import AuditLog from '../models/AuditLog.js';
import { runInTenant } from '../config/tenantContext.js';
import { recordPanelActivity } from '../services/dashboardSchedule.js';
import { mailTransport, panelUrlFor } from '../services/mail/index.js';

const DUMMY_PASSWORD_HASH = bcrypt.hashSync('skygenpanel-invalid-login-placeholder', 12);

/**
 * Cunha um bilhete e o manda por e-mail. `false` em toda saída ruim.
 *
 * Nunca lança e nunca é condição de nada — a mesma regra do convite, pelo
 * mesmo motivo: quem chama já decidiu o que a resposta vai ser antes de saber
 * se a mensagem saiu, e um SMTP fora do ar não pode virar um 500 numa rota que
 * responde a mesma coisa de qualquer jeito.
 *
 * O endereço do link vem do domínio-base ou de `PUBLIC_BASE_URL`, nunca do
 * `Host` da requisição. Aqui isso é mais grave do que no convite: o pedido de
 * redefinição é PÚBLICO, então o cabeçalho é escolhido por qualquer um — e um
 * link montado com ele mandaria à caixa de entrada de uma pessoa real um token
 * verdadeiro apontando para o servidor de quem pediu. Sem endereço conhecido,
 * não sai mensagem nenhuma.
 *
 * O texto é curto porque carrega uma CREDENCIAL. Vai nele o nome do provedor,
 * até quando vale e o link — e nada que faça de uma caixa de entrada um lugar
 * onde mora dado de provedor.
 */
async function enviarBilhete({ req, purpose, userId, tenantId, email, rota, assunto, corpo }) {
  const transporte = mailTransport();
  if (transporte.name === 'none') return false;

  const tenant = await Tenant.findPublicById(tenantId);
  const base = panelUrlFor(tenant);
  if (!base) return false;

  const { token } = await AuthTicket.create({ purpose, userId, tenantId, email });
  const nome = tenant?.name || 'SkyGenPanel';
  // Os dois prazos vão para o texto, e cada mensagem usa o que lhe cabe: meia
  // hora se diz em minutos, um dia se diz em horas. Vindos do próprio
  // `TTL_MS`, e não escritos na tradução, para que mexer no prazo não deixe
  // treze idiomas prometendo outro.
  const minutos = Math.round(AuthTicket.TTL_MS[purpose] / 60000);
  const horas = Math.round(AuthTicket.TTL_MS[purpose] / 3600000);
  return transporte.send({
    to: email,
    subject: req.t(assunto, { provider: nome }),
    text: req.t(corpo, {
      provider: nome,
      link: `${base}${rota}#${token}`,
      minutes: minutos,
      hours: horas
    })
  });
}

/**
 * Registra que este provedor tem gente usando o painel.
 *
 * É o que decide a cadência com que o painel dele é atualizado em segundo
 * plano — ver `services/dashboardSchedule.js`. Fica no login e na renovação de
 * token porque são os dois pontos em que se SABE que há alguém do outro lado, e
 * porque a renovação é de hora em hora: a marca acompanha quem continua ali,
 * sem uma escrita por requisição.
 *
 * O escopo é aberto pelo provedor do vínculo, e não herdado: no login por
 * subdomínio o escopo da requisição é o do host, que é o mesmo — mas numa
 * instalação sem resolução por host não há escopo nenhum, e é o vínculo que
 * sabe em qual provedor a pessoa acabou de entrar.
 */
const marcarAtividade = (tenantId) => runInTenant(Number(tenantId), () => recordPanelActivity());

/**
 * Which provider this sign-in is for.
 *
 * `users` is the identity table and `username` is still global, so the password
 * answers "who is this"; `tenant_users` answers "and working for whom". A
 * consultant or a reseller with one login across several ISPs is the ordinary
 * arrangement in this market, so this can return more than one candidate and
 * has to choose — but never at random, and never invisibly:
 *
 *  - the caller may name the provider outright, in `tenantId`. That is the
 *    honest answer to ambiguity, and it is what a provider picker on the login
 *    screen will send. A `tenantId` for a provider the person does not work for
 *    resolves to nothing rather than falling back to another one, so a wrong
 *    guess never quietly signs somebody into the wrong ISP.
 *  - with nothing named, one membership is that membership.
 *  - with nothing named and several, it is the OLDEST membership — the provider
 *    they have worked for longest, which for a reseller is the one that is
 *    theirs and for everybody else is their only real employer. It is chosen by
 *    a rule rather than by whatever the database felt like returning first, it
 *    is stable across engines and restarts, and the response says which
 *    provider was picked so the choice is on screen rather than buried in a
 *    token. Switching provider is signing in again naming the other one.
 *
 * No membership returns null, and the caller must refuse the sign-in.
 */
async function membershipForLogin(userId, requestedTenantId) {
  if (requestedTenantId !== undefined && requestedTenantId !== null && requestedTenantId !== '') {
    const id = Number(requestedTenantId);
    if (!Number.isInteger(id) || id <= 0) return null;
    return TenantUser.find(id, userId);
  }
  const memberships = await TenantUser.listForUser(userId);
  return memberships[0] || null;
}

/**
 * Whether this session also holds the control plane.
 *
 * Reported to the panel so it can decide whether to show the providers screen
 * at all. It has to be its own field because there is no role that implies it:
 * a provider's own administrator is `admin` too, so gating the screen on the
 * role would put a link in front of most of the panel's administrators pointing
 * at routes that answer them as if they did not exist.
 *
 * Read from `platform_admins` at request time, exactly as `requirePlatformAdmin`
 * reads it, and deliberately NOT carried in the token. It is a claim of record
 * — what to draw — and never authority: the guard re-reads the table anyway, so
 * a stale `true` here shows somebody a menu entry whose routes then refuse
 * them, which is a wrong screen rather than a breach. Putting it in the token
 * would make it look like the answer, and a claim nobody trusts is one somebody
 * eventually trusts by mistake.
 *
 * Always false on self-hosted, where there is no control plane to hold. That
 * lets the panel hide the screen without knowing which edition it is talking
 * to, and it means a stray roster row — an install that ran the grant script
 * and later moved to the self-hosted edition — cannot light up a menu whose
 * routes are not mounted.
 */
async function holdsControlPlane(userId) {
  if (!IS_SAAS) return false;
  return PlatformAdmin.has(userId);
}

/**
 * O que um provedor novo precisa para existir: nome, subdomínio, e a conta de
 * quem vai administrá-lo. Reunido aqui porque é a única rota que cria as
 * QUATRO coisas de uma vez — provedor, seed, pessoa e vínculo — e as quatro
 * têm que nascer juntas ou não nascer.
 */
const SIGNUP_NAME_MAX = 128;
const BCRYPT_ROUNDS = 12;

class AuthController {
  /**
   * `POST /api/auth/signup` — um ISP se cadastra sozinho. Só na edição SaaS,
   * e só onde há subdomínio: sem `TENANT_BASE_DOMAIN` não haveria endereço
   * para entregar ao provedor novo, e o resolvedor responderia sempre com o
   * primeiro da tabela.
   *
   * Passa pelo MESMO caminho que o console usa para cunhar um provedor —
   * `Tenant.create` + `seedDefaults` na mesma transação — para que um ISP que
   * se cadastrou sozinho seja indistinguível de um que nós criamos: mesmos
   * settings, mesmo catálogo, mesma assinatura em `trial`. A pessoa nasce
   * `owner` do provedor e de mais nada — nunca do plano de controle.
   *
   * Não devolve token, de propósito: o painel do provedor novo vive em outro
   * host (`slug.painel…`), e um token guardado neste host não serviria lá —
   * `tokenMatchesHost` o recusaria. Devolve o endereço, e a pessoa entra lá.
   */
  static async signup(req, res) {
    try {
      if (!usesTenantSubdomains()) {
        return res.status(404).json(createErrorResponse(req.t('common.routeNotFound')));
      }
      const body = req.body ?? {};
      const slug = String(body.slug ?? '');
      const name = String(body.providerName ?? '').trim();
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      // Conta nova nasce com e-mail, como toda conta desde o login por e-mail —
      // e a do dono de um provedor mais ainda: é a que vai cadastrar as outras.
      const email = User.normalizeEmail(body.email);

      const problem = slugProblem(slug);
      if (problem) return res.status(400).json(createErrorResponse(problem));
      if (name.length < 1 || name.length > SIGNUP_NAME_MAX) {
        return res.status(400).json(createErrorResponse(req.t('auth.signupInvalid')));
      }
      if (username.length < 3 || username.length > 64 || password.length < 8 || password.length > 128) {
        return res.status(400).json(createErrorResponse(req.t('auth.signupInvalid')));
      }
      if (!email || !isValidEmail(email)) {
        return res.status(400).json(createErrorResponse(req.t('auth.emailInvalid')));
      }
      // As duas colisões respondem 409 com palavras diferentes, porque as duas
      // correções são diferentes: outro subdomínio, ou outro login. O login é
      // conferido contra o espaço de nomes inteiro — nome e e-mail vivem no
      // mesmo — pelo motivo escrito em `User.findByLogin`.
      if (await Tenant.findBySlug(slug)) {
        return res.status(409).json(createErrorResponse(req.t('auth.signupSlugTaken')));
      }
      if (await User.loginConflict({ username, email })) {
        return res.status(409).json(createErrorResponse(req.t('auth.signupUsernameTaken')));
      }

      let tenantId;
      let userId;
      try {
        await getDb().transaction(async (trx) => {
          tenantId = await Tenant.create({ slug, name }, trx);
          // Só o provedor que acabou de nascer. A passagem completa custa
          // dezessete consultas por provedor existente, e esta é uma rota
          // pública — ver `seedDefaults`.
          await seedDefaults(trx, { tenantIds: [tenantId] });
          userId = await User.create({
            username,
            password: await bcrypt.hash(password, BCRYPT_ROUNDS),
            role: 'owner',
            email
          }, trx);
          await TenantUser.create({ tenantId, userId, role: 'owner' }, trx);
        });
      } catch (error) {
        // Two signups racing on the same slug or the same login: the loser
        // lands on a unique index and is told the same thing it would have
        // been told a moment earlier.
        if (await Tenant.findBySlug(slug)) {
          return res.status(409).json(createErrorResponse(req.t('auth.signupSlugTaken')));
        }
        if (await User.loginConflict({ username, email })) {
          return res.status(409).json(createErrorResponse(req.t('auth.signupUsernameTaken')));
        }
        throw error;
      }

      const tenant = await Tenant.findById(tenantId);
      // Na trilha da plataforma sem ator: ninguém nosso fez isto. `via` diz de
      // onde veio, para a lista do console distinguir "criamos" de "entrou".
      await PlatformAudit.record({
        action: PlatformAudit.ACTIONS.TENANT_CREATED,
        tenant,
        detail: { via: 'signup', ownerUserId: userId },
        ip: req.ip ?? null
      });

      // A prova do endereço, mandada agora e não um dia depois.
      //
      // Este é o único e-mail que se tem do dono de um provedor novo, e é por
      // ele que vai a cobrança, o aviso de vencimento e a redefinição de senha
      // — que, desde a fatia dos bilhetes, só sai para endereço PROVADO. Um
      // cadastro que nasce sem provar nada é um cliente que, no dia em que
      // esquecer a senha, não tem por onde voltar.
      //
      // Melhor esforço, e nunca condição: `enviarBilhete` devolve `false` num
      // deploy sem SMTP e o cadastro segue igual. Travar o nascimento do
      // provedor por causa do transporte de e-mail transformaria uma
      // configuração opcional — `SMTP_URL` é opcional, e está escrito no
      // runbook — em requisito de funcionamento. O que muda é a resposta
      // DIZER se foi: a tela sabe se manda a pessoa olhar a caixa de entrada
      // ou se pede a prova depois, de dentro do painel.
      //
      // O provedor vai explícito, e tem que ir: no apex `req.tenantId` é nulo,
      // e num host de provedor é o do provedor ERRADO — o que hospeda a tela
      // de cadastro, não o que acabou de nascer.
      const provado = await enviarBilhete({
        req,
        purpose: AuthTicket.PURPOSES.EMAIL_VERIFICATION,
        userId,
        tenantId,
        email,
        rota: '/verify-email',
        assunto: 'auth.emailVerifyMailSubject',
        corpo: 'auth.emailVerifyMailBody'
      });

      const base = panelBaseDomain();
      return res.status(201).json(createResponse(req.t('auth.signupCreated'), {
        tenant: { slug: tenant.slug, name: tenant.name },
        panelUrl: base ? `https://${tenant.slug}.${base}` : null,
        emailed: provado
      }));
    } catch (error) {
      console.error('Signup error:', error);
      return res.status(500).json(createErrorResponse(req.t('auth.signupFailed'), error.message));
    }
  }

  /**
   * `POST /api/auth/impersonate/redeem` — o bilhete vira a sessão de leitura.
   *
   * Roda no host do PROVEDOR, sem sessão, e é isso que a torna a peça certa: o
   * token nasce no origin onde vai viver, e nunca atravessou uma URL. Quem
   * chega aqui tem o bilhete que o console pôs no fragmento do endereço para
   * onde mandou o navegador.
   *
   * Três conferências, e a terceira é a que existe por causa dos subdomínios:
   *
   * 1. o bilhete resgata (existe, não venceu, não foi usado) — as três falhas
   *    respondem a mesma coisa, porque quem tem um bilhete ruim não tem por que
   *    aprender qual delas é;
   * 2. quem o cunhou continua no cadastro da plataforma, lido agora e não
   *    quando o bilhete foi feito: tirar alguém de lá tem que invalidar o que
   *    ela deixou pendurado;
   * 3. o bilhete é DESTE host. Mesma regra do convite, e pelo mesmo motivo: um
   *    bilhete do provedor A resgatado no endereço do provedor B produziria uma
   *    sessão para A servida por uma porta que não é a dele.
   *
   * A trilha vai no `audit_log` do provedor personificado, e é aqui e não na
   * cunhagem: o que o ISP quer poder perguntar é "entraram no meu painel?", e a
   * resposta é a sessão ter começado, não alguém ter pedido um bilhete.
   */
  static async redeemImpersonation(req, res) {
    try {
      const ticketValue = String(req.body?.ticket ?? '').trim();
      if (!ticketValue) {
        return res.status(400).json(createErrorResponse(req.t('auth.impersonationTicketRequired')));
      }

      const recusa = () => res.status(404).json(
        createErrorResponse(req.t('auth.impersonationTicketInvalid'))
      );

      const ticket = await ImpersonationTicket.redeem(ticketValue);
      if (!ticket) return recusa();

      const platformUser = await User.findById(ticket.platform_user_id);
      if (!platformUser || !(await PlatformAdmin.has(platformUser.id))) return recusa();

      // `req.tenantId` é o provedor que o host nomeia — o resolvedor já
      // respondeu 404 para um host que não nomeia nenhum.
      if (Number(ticket.tenant_id) !== Number(req.tenantId)) return recusa();

      const tenant = await Tenant.findPublicById(ticket.tenant_id);
      if (!tenant) return recusa();

      await AuditLog.record({
        action: AuditLog.ACTIONS.PLATFORM_IMPERSONATED,
        actorUserId: platformUser.id,
        actorUsername: platformUser.username,
        actorKind: 'platform',
        subjectType: 'tenant',
        subjectId: ticket.tenant_id,
        detail: { ticketId: ticket.id },
        ip: req.ip ?? null
      });

      const token = generateImpersonationToken(platformUser, ticket.tenant_id);

      return res.json(createResponse(req.t('auth.impersonationStarted'), {
        user: {
          id: platformUser.id,
          username: platformUser.username,
          email: platformUser.email ?? null,
          role: 'viewer',
          tenantId: Number(ticket.tenant_id),
          // Falso de propósito, e não é contradição: dentro de uma
          // personificação o console não é alcançável — `requirePlatformAdmin`
          // recusa esta sessão. Dizer `true` acenderia um menu cujas rotas
          // respondem 404 a ela.
          isPlatformAdmin: false,
          impersonation: { platformUsername: platformUser.username },
          createdAt: platformUser.created_at,
          updatedAt: platformUser.updated_at
        },
        tenant: { slug: tenant.slug, name: tenant.name },
        token
      }));
    } catch (error) {
      console.error('Redeem impersonation error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('auth.impersonationFailed'), error.message)
      );
    }
  }

  static async login(req, res) {
    try {
      const { username, password, tenantId } = req.body;

      if (!username || !password) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.credentialsRequired'))
        );
      }
      const normalizedUsername = String(username).trim();
      if (
        normalizedUsername.length < 1 ||
        normalizedUsername.length > 64 ||
        String(password).length > 128
      ) {
        await bcrypt.compare(String(password).slice(0, 128), DUMMY_PASSWORD_HASH);
        return res.status(401).json(
          createErrorResponse(req.t('auth.invalidCredentials'))
        );
      }
      
      // Nome OU e-mail, numa consulta só. Os dois vivem no mesmo espaço de
      // nomes (ver `User.findByLogin`), então este identificador nunca casa
      // duas contas — e se casasse, a resposta é null e ninguém entra.
      const user = await User.findByLogin(normalizedUsername);

      if (!user) {
        await bcrypt.compare(String(password), DUMMY_PASSWORD_HASH);
        return res.status(401).json(
          createErrorResponse(req.t('auth.invalidCredentials'))
        );
      }

      // Com `LOGIN_REQUIRES_EMAIL` ligado, o nome deixa de servir. A senha é
      // conferida do mesmo jeito ANTES de recusar: parar aqui sem gastar o
      // bcrypt faria o tempo de resposta contar quem tem e-mail cadastrado e
      // quem não tem, para quem cronometrasse.
      const identifierAccepted = acceptsIdentifier(normalizedUsername, user);

      const isMatch = await bcrypt.compare(password, user.password);

      if (!isMatch || !identifierAccepted) {
        return res.status(401).json(
          createErrorResponse(req.t('auth.invalidCredentials'))
        );
      }

      // The host wins over the body. Where providers have subdomains, the
      // address the person typed is the provider they mean, and letting a
      // `tenantId` in the payload override it would mean the login screen of
      // one ISP mints a session for another — refused a moment later by the
      // host check in `authenticateToken`, but only after confirming to the
      // caller that the credentials are good for SOMEBODY.
      const membership = await membershipForLogin(
        user.id,
        req.hostTenantId ?? tenantId
      );

      // Somebody who works for nobody cannot sign in — there is no provider to
      // put the session in, and a session with no provider is the unscoped read
      // this whole mechanism exists to prevent. The refusal is the same status
      // and the same message as a wrong password, deliberately: telling the two
      // apart would confirm a valid username to whoever is trying them, and on
      // a deployment with several ISPs it would confirm which staff belong to
      // which one.
      if (!membership) {
        return res.status(401).json(
          createErrorResponse(req.t('auth.invalidCredentials'))
        );
      }

      const { accessToken, refreshToken } = generateTokens(user, membership);
      await marcarAtividade(membership.tenant_id);

      return res.json(
        createResponse(req.t('auth.loginSuccess'), {
          user: {
            id: user.id,
            username: user.username,
            // Os dois campos do e-mail vão aqui pela mesma razão que vão em
            // `/api/auth/user`: é esta resposta que a tela guarda logo depois
            // do login, e as duas precisam dizer a mesma coisa — senão o aviso
            // de endereço não confirmado só apareceria depois de um F5.
            email: user.email ?? null,
            emailVerified: Boolean(user.email_verified_at),
            // The membership's role, not `users.role`: it is what the token
            // carries and what the panel is about to gate its screens on, so
            // the two disagreeing would show an operator the buttons of an
            // administrator they are not, here.
            role: membership.role,
            tenantId: Number(membership.tenant_id),
            isPlatformAdmin: await holdsControlPlane(user.id),
            createdAt: user.created_at,
            updatedAt: user.updated_at
          },
          token: accessToken,
          refreshToken
        })
      );
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  static async getSetupStatus(req, res) {
    try {
      const count = await User.count();
      return res.json(
        createResponse(req.t('auth.setupStatusRetrieved'), { needsSetup: count === 0 })
      );
    } catch (error) {
      console.error('Setup status error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('auth.setupStatusFailed'), error.message)
      );
    }
  }

  static async setupAdmin(req, res) {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.credentialsRequired'))
        );
      }

      const normalizedUsername = String(username).trim();
      if (normalizedUsername.length < 3 || normalizedUsername.length > 64) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.usernameLength'))
        );
      }

      if (String(password).length < 8 || String(password).length > 128) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.passwordLength'))
        );
      }

      // Conta NOVA nasce com e-mail, sem exceção — e a primeira de todas menos
      // ainda: é a única do install que não tem quem a conserte depois, porque
      // é ela quem cadastra as outras. Contas sem endereço existem só como
      // herança de antes desta versão.
      const email = User.normalizeEmail(req.body?.email);
      if (!email || !isValidEmail(email)) {
        return res.status(400).json(createErrorResponse(req.t('auth.emailInvalid')));
      }
      if (await User.loginConflict({ username: normalizedUsername, email })) {
        return res.status(409).json(createErrorResponse(req.t('auth.usernameTaken')));
      }

      const hashedPassword = await bcrypt.hash(password, 12);
      // The person AND their membership, in one transaction. A first admin
      // without a membership would be a fresh install nobody can sign in to:
      // the account exists, the password is right, and the login refuses
      // because there is no provider to put the session in.
      const { id: userId, tenantId, role } = await User.createInitialAdmin({
        username: normalizedUsername,
        password: hashedPassword,
        email
      });
      const user = { id: userId, username: normalizedUsername };

      const { accessToken, refreshToken } = generateTokens(user, { tenant_id: tenantId, role });

      return res.status(201).json(
        createResponse(req.t('auth.adminCreated'), {
          user: {
            id: userId,
            username: normalizedUsername,
            email,
            role,
            tenantId,
            // Read back rather than assumed from the edition: setup is the one
            // place that WRITES the roster row, and the panel walks straight
            // into the session from here without asking again.
            isPlatformAdmin: await holdsControlPlane(userId)
          },
          token: accessToken,
          refreshToken
        })
      );
    } catch (error) {
      console.error('Setup admin error:', error);
      if (error.code === 'SETUP_COMPLETED') {
        return res.status(409).json(
          createErrorResponse(req.t('auth.setupAlreadyCompleted'))
        );
      }
      return res.status(500).json(
        createErrorResponse(req.t('auth.adminCreateFailed'), error.message)
      );
    }
  }

  static async getCurrentUser(req, res) {
    try {
      const userId = req.user.userId;
      const user = await User.findById(userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse(req.t('auth.userNotFound'))
        );
      }
      
      return res.json(
        createResponse(req.t('auth.userRetrieved'), {
          id: user.id,
          username: user.username,
          email: user.email ?? null,
          // Se o endereço acima foi provado. A tela de conta lê isto para
          // oferecer o botão que manda a prova — e é a mesma linha que decide
          // se a redefinição de senha vai funcionar para esta pessoa no dia em
          // que ela precisar, que é um dia em que ela não vai poder resolver.
          emailVerified: Boolean(user.email_verified_at),
          // From the session rather than from the row, for the same reason the
          // login response reports it that way: this is the answer the panel
          // rebuilds its menus from after a page reload, and `users.role` is
          // not what this session is authorised with.
          role: req.user.role,
          tenantId: req.user.tenantId,
          // Numa personificação isto é falso mesmo sendo a pessoa do cadastro
          // da plataforma: dentro dela o console não é alcançável, e um `true`
          // aqui acenderia um menu cujas rotas respondem 404 a esta sessão.
          // Mesma resposta que o resgate deu; esta rota é a que a tela relê
          // depois de um F5, e as duas têm que dizer a mesma coisa.
          isPlatformAdmin: req.user.impersonation ? false : await holdsControlPlane(user.id),
          // Presente só numa personificação, e é o que a faixa no alto da tela
          // lê para dizer de quem é a sessão que está olhando.
          impersonation: req.user.impersonation ?? null,
          createdAt: user.created_at,
          updatedAt: user.updated_at
        })
      );
    } catch (error) {
      console.error('Get current user error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  static async logout(req, res) {
    await User.revokeSessions(req.user.userId);
    return res.json(
      createResponse(req.t('auth.logoutSuccess'))
    );
  }

  static async refreshToken(req, res) {
    try {
      const { refreshToken } = req.body;
      
      if (!refreshToken) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.refreshTokenRequired'))
        );
      }
      if (typeof refreshToken !== 'string' || refreshToken.length > 4096) {
        return res.status(403).json(createErrorResponse(req.t('auth.invalidRefreshToken')));
      }
      
      const decoded = verifyToken(refreshToken);
      
      if (!decoded) {
        return res.status(403).json(
          createErrorResponse(req.t('auth.invalidRefreshToken'))
        );
      }
      
      if (!decoded.tokenType || decoded.tokenType !== 'refresh') {
        return res.status(403).json(
          createErrorResponse(req.t('auth.invalidTokenType'))
        );
      }
      
      const user = await User.findById(decoded.userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse(req.t('auth.userNotFound'))
        );
      }

      if (Number(user.token_version || 0) !== Number(decoded.tokenVersion || 0)) {
        return res.status(403).json(
          createErrorResponse(req.t('auth.refreshSessionInvalid'))
        );
      }

      // A chave `LOGIN_REQUIRES_EMAIL`, lida aqui também. Sem isto, virá-la só
      // trancava quem ainda não tinha sessão: quem já estava dentro renovava
      // por sete dias. Assim a chave passa a valer na próxima renovação — dentro
      // da vida do token de acesso — e a pessoa cai na tela de login, onde a
      // regra que a trancou é a mesma que ela vai ler.
      if (!canHoldSession(user)) {
        return res.status(403).json(
          createErrorResponse(req.t('auth.refreshSessionInvalid'))
        );
      }

      // The same provider the session was already running in, re-read from the
      // table so a membership ended since the refresh token was minted ends the
      // session at its next hour rather than at its next week. A refresh token
      // from before this change names no provider and is resolved the same way
      // an old access token is: through the sole membership, or refused.
      const membership = await resolveMembership(user.id, decoded.tenantId);
      if (!membership) {
        return res.status(403).json(
          createErrorResponse(req.t('auth.refreshSessionInvalid'))
        );
      }

      const { accessToken, refreshToken: newRefreshToken } = generateTokens(user, membership);
      await marcarAtividade(membership.tenant_id);

      return res.json(
        createResponse(req.t('auth.tokenRefreshed'), {
          token: accessToken,
          refreshToken: newRefreshToken
        })
      );
    } catch (error) {
      console.error('Refresh token error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  static async changePassword(req, res) {
    try {
      const userId = req.user.userId;
      const { currentPassword, newPassword } = req.body;
      
      if (!currentPassword || !newPassword) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.passwordChangeRequired'))
        );
      }

      if (String(newPassword).length < 8 || String(newPassword).length > 128) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.newPasswordLength'))
        );
      }
      
      const user = await User.findById(userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse(req.t('auth.userNotFound'))
        );
      }
      
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      
      if (!isMatch) {
        return res.status(401).json(
          createErrorResponse(req.t('auth.currentPasswordIncorrect'))
        );
      }
      
      const hashedPassword = await bcrypt.hash(newPassword, 12);
      await User.updatePassword(userId, hashedPassword);
      
      return res.json(
        createResponse(req.t('auth.passwordUpdated'))
      );
    } catch (error) {
      console.error('Change password error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  static async changeUsername(req, res) {
    try {
      const userId = req.user.userId;
      const { currentUsername, newUsername } = req.body;
      
      if (!currentUsername || !newUsername) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.usernameChangeRequired'))
        );
      }

      const normalizedUsername = String(newUsername).trim();
      if (normalizedUsername.length < 3 || normalizedUsername.length > 64) {
        return res.status(400).json(
          createErrorResponse(req.t('auth.newUsernameLength'))
        );
      }
      
      const user = await User.findById(userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse(req.t('auth.userNotFound'))
        );
      }
      
      if (user.username !== currentUsername) {
        return res.status(401).json(
          createErrorResponse(req.t('auth.currentUsernameIncorrect'))
        );
      }
      
      // Contra o espaço de nomes INTEIRO, e não só contra os nomes de usuário.
      //
      // Sem isto sobra um buraco que não é sobre quem troca, é sobre a vítima:
      // trocar o próprio nome para o e-mail de um colega faria aquele endereço
      // casar duas contas, e `findByLogin` recusa um identificador ambíguo —
      // ou seja, o colega deixa de conseguir entrar, e nada na tela dele
      // explica por quê. Negar acesso a outra pessoa não pode ser efeito
      // colateral de renomear a si mesmo.
      if (await User.loginConflict({ username: normalizedUsername, exceptId: userId })) {
        return res.status(409).json(
          createErrorResponse(req.t('auth.usernameTaken'))
        );
      }
      
      await User.updateUsername(userId, normalizedUsername);
      
      return res.json(
        createResponse(req.t('auth.usernameUpdated'))
      );
    } catch (error) {
      console.error('Change username error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  /**
   * O e-mail de login da própria pessoa.
   *
   * É por aqui que quem já usa o painel migra: a coluna nasceu nula para todo
   * mundo que existia antes dela, e nenhuma migração podia adivinhar o
   * endereço. Enquanto houver conta sem e-mail, `LOGIN_REQUIRES_EMAIL` não pode
   * ser virado — e é `GET /api/users` que mostra quem falta.
   *
   * Exige a senha atual, como qualquer mudança de credencial. O e-mail vai
   * virar o identificador de login: quem alcançasse uma sessão aberta e
   * trocasse o endereço sem provar a senha estaria trocando por onde se entra
   * naquela conta.
   *
   * **Não verifica o endereço**, e vale dizer o que isso custa e o que não
   * custa. Não custa nada hoje: cadastrar o e-mail de outra pessoa não abre a
   * conta dela — a senha continua sendo exigida —, e o pior que se consegue é
   * ocupar um endereço que não é seu, o que o índice único já impede de virar
   * duas contas. O dia em que existir redefinição de senha por e-mail, isso
   * muda inteiro: um endereço não verificado passa a ser um caminho para dentro
   * da conta, e a verificação vira obrigatória ANTES daquele recurso, não
   * depois. Fica escrito aqui porque é aqui que alguém vai olhar.
   */
  static async changeEmail(req, res) {
    try {
      const userId = req.user.userId;
      const { currentPassword, email } = req.body ?? {};

      if (!currentPassword || !email) {
        return res.status(400).json(createErrorResponse(req.t('auth.emailChangeRequired')));
      }
      const normalizado = User.normalizeEmail(email);
      if (!normalizado || !isValidEmail(normalizado)) {
        return res.status(400).json(createErrorResponse(req.t('auth.emailInvalid')));
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json(createErrorResponse(req.t('auth.userNotFound')));
      }
      if (!await bcrypt.compare(String(currentPassword), user.password)) {
        return res.status(401).json(createErrorResponse(req.t('auth.currentPasswordIncorrect')));
      }

      // Contra o espaço de nomes inteiro, ignorando a própria linha: salvar o
      // endereço que já é o seu não pode responder "em uso".
      if (await User.loginConflict({ email: normalizado, exceptId: userId })) {
        return res.status(409).json(createErrorResponse(req.t('auth.emailTaken')));
      }

      await User.updateEmail(userId, normalizado);
      // O endereço novo entra NÃO provado — `updateEmail` limpa o carimbo — e a
      // prova sai atrás. Ela nunca é condição da troca: um SMTP fora do ar
      // deixaria a pessoa sem poder cadastrar o endereço com que ela entra, e
      // trancar o login por causa do correio é trocar um problema por um pior.
      // Quem não recebeu pede de novo na tela de conta.
      const provaEnviada = await enviarBilhete({
        req,
        purpose: AuthTicket.PURPOSES.EMAIL_VERIFICATION,
        userId,
        tenantId: Number(req.tenantId),
        email: normalizado,
        rota: '/verify-email',
        assunto: 'auth.emailVerifyMailSubject',
        corpo: 'auth.emailVerifyMailBody'
      });
      // Auditado no provedor da sessão: trocar o e-mail é trocar por onde se
      // entra nesta conta, e isso é da mesma família da troca de papel e da
      // revelação de senha — coisas que alguém vai querer reconstruir depois.
      // O endereço ANTIGO não entra: a trilha diz que mudou e para qual, que é
      // o que responde "desde quando", sem virar um histórico de endereços de
      // gente.
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.LOGIN_EMAIL_CHANGED,
        subjectType: 'user',
        subjectId: userId,
        detail: { email: normalizado }
      });

      return res.json(createResponse(req.t('auth.emailUpdated'), {
        email: normalizado,
        verified: false,
        verificationSent: provaEnviada
      }));
    } catch (error) {
      console.error('Change email error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  /**
   * Se este deployment já pode exigir e-mail no login, e quem falta.
   *
   * Existe para que a decisão do passo 3 seja tomada olhando um número em vez
   * de na esperança. Só quem administra a equipe vê — a lista de quem ainda não
   * cadastrou endereço é a mesma informação da tela de operadores.
   */
  static async emailReadiness(req, res) {
    try {
      const total = await User.count();
      const semEmail = await User.countWithoutEmail();
      return res.json(createResponse(req.t('auth.emailReadiness'), {
        loginRequiresEmail: LOGIN_REQUIRES_EMAIL,
        total,
        withoutEmail: semEmail,
        ready: semEmail === 0
      }));
    } catch (error) {
      console.error('Email readiness error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  /**
   * "Esqueci minha senha": manda o link, ou não manda, e responde a mesma coisa.
   *
   * A resposta é IDÊNTICA em todos os casos — conta que não existe, conta sem
   * endereço, endereço não provado, pessoa que não trabalha neste provedor,
   * deploy sem SMTP. É a rota mais exposta do painel: pública, sem credencial
   * nenhuma, e com um campo onde se digita o identificador de outra pessoa.
   * Qualquer diferença de resposta a transforma num oráculo — "este e-mail tem
   * conta aqui" é exatamente o que uma lista de alvos precisa saber, e num
   * painel de ISP a pergunta seguinte é quem são os operadores do concorrente.
   *
   * Por isso não há 404 aqui, nem 409, nem mensagem diferente: há 200, sempre,
   * dizendo que SE existir uma conta a mensagem foi mandada. Quem tem a conta
   * recebe o link; quem está sondando recebe a mesma frase que receberia se
   * tivesse acertado.
   *
   * As condições para de fato mandar, todas em silêncio:
   *
   * - a conta existe e pode ter sessão neste deploy (`canHoldSession`);
   * - ela tem endereço, e o endereço foi PROVADO. Sem isso a redefinição
   *   seria o caminho para dentro de uma conta cujo endereço foi digitado
   *   errado uma vez — ver a migração 0039;
   * - a pessoa trabalha NESTE provedor. O link aponta para este painel, e o
   *   pedido chega pelo host dele; mandar a quem não é daqui usaria o nome
   *   deste provedor para falar com alguém que não o conhece.
   */
  static async requestPasswordReset(req, res) {
    // Montada uma vez e devolvida em cada saída, para que seja literalmente a
    // mesma resposta e não duas frases que alguém possa deixar de sincronizar.
    const responder = () => res.json(createResponse(req.t('auth.passwordResetRequested')));
    try {
      const identificador = String(req.body?.identifier ?? '').trim();
      if (!identificador || identificador.length > 255) return responder();

      const user = await User.findByLogin(identificador);
      if (!user || !canHoldSession(user)) return responder();

      const email = User.normalizeEmail(user.email);
      if (!email || !user.email_verified_at) return responder();

      if (!(await TenantUser.find(req.tenantId, user.id))) return responder();

      // A trilha é do provedor e vem ANTES do envio, porque ela registra o
      // pedido e não a entrega: um SMTP que recusa não apaga o fato de alguém
      // ter pedido uma senha nova para esta conta.
      await runInTenant(Number(req.tenantId), () => AuditLog.record({
        action: AuditLog.ACTIONS.PASSWORD_RESET_REQUESTED,
        actorUserId: user.id,
        actorUsername: user.username,
        subjectType: 'user',
        subjectId: user.id,
        ip: req.ip ?? null
      }));

      await enviarBilhete({
        req,
        purpose: AuthTicket.PURPOSES.PASSWORD_RESET,
        userId: user.id,
        tenantId: Number(req.tenantId),
        email,
        rota: '/reset-password',
        assunto: 'auth.passwordResetMailSubject',
        corpo: 'auth.passwordResetMailBody'
      });

      return responder();
    } catch (error) {
      // Até o erro responde igual. Um 500 que só acontece para identificador
      // que existe é a mesma pista que as mensagens diferentes seriam.
      console.error('Password reset request error:', error);
      return responder();
    }
  }

  /**
   * O link aberto vira a senha nova. Não vira sessão.
   *
   * Não emitir token aqui é deliberado, e é a diferença entre "quem lê a caixa
   * de entrada entra no painel" e "quem lê a caixa de entrada escolhe uma senha
   * e depois entra com ela". A segunda custa uma tela a mais e faz a senha nova
   * ser usada uma vez na frente de quem a escolheu — que é como se descobre,
   * ali mesmo, que ela foi digitada errada. `updatePassword` ainda incrementa o
   * `token_version`, então toda sessão antiga morre: se a redefinição foi de
   * quem invadiu, ela derruba o invasor junto.
   */
  static async confirmPasswordReset(req, res) {
    try {
      const token = String(req.body?.token ?? '').trim();
      const novaSenha = String(req.body?.password ?? '');

      if (!token || !novaSenha) {
        return res.status(400).json(createErrorResponse(req.t('auth.passwordResetRequired')));
      }
      if (novaSenha.length < 8 || novaSenha.length > 128) {
        return res.status(400).json(createErrorResponse(req.t('auth.newPasswordLength')));
      }

      // Vencido, já usado, inexistente, de outro host e de um endereço que não
      // é mais o da conta respondem todos a mesma coisa, pelo motivo de sempre.
      const recusa = () => res.status(404).json(
        createErrorResponse(req.t('auth.passwordResetInvalid'))
      );

      // O host entra no resgate, não depois dele: o bilhete foi cunhado no
      // painel de um provedor e é lá que ele vale. Dentro da condição, a
      // tentativa pela porta errada não casa linha nenhuma — não gasta o
      // bilhete de quem o recebeu. Ver `AuthTicket.redeem`.
      const ticket = await AuthTicket.redeem({
        token,
        purpose: AuthTicket.PURPOSES.PASSWORD_RESET,
        tenantId: req.tenantId
      });
      if (!ticket) return recusa();

      const user = await User.findById(ticket.user_id);
      if (!user || !canHoldSession(user)) return recusa();

      // O endereço da conta ainda é aquele para onde a mensagem foi? Se a
      // pessoa trocou de endereço depois de pedir, o link antigo morre aqui —
      // é o que faz a troca de endereço fechar o caminho que ela deveria
      // fechar, em vez de deixar uma credencial viva na caixa antiga.
      if (User.normalizeEmail(user.email) !== User.normalizeEmail(ticket.email)) return recusa();

      await User.updatePassword(user.id, await bcrypt.hash(novaSenha, 12));

      await runInTenant(Number(ticket.tenant_id), () => AuditLog.record({
        action: AuditLog.ACTIONS.PASSWORD_RESET_COMPLETED,
        actorUserId: user.id,
        actorUsername: user.username,
        subjectType: 'user',
        subjectId: user.id,
        detail: { ticketId: ticket.id },
        ip: req.ip ?? null
      }));

      return res.json(createResponse(req.t('auth.passwordResetDone')));
    } catch (error) {
      console.error('Password reset confirm error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  /**
   * Pede a prova do próprio endereço. Autenticada, e por isso franca.
   *
   * Ao contrário do pedido de redefinição, aqui quem pergunta já provou quem é
   * — então não há o que esconder e as respostas podem ser diferentes: sem
   * endereço, já provado, sem transporte no deploy. Cada uma dessas é algo que
   * a pessoa precisa ler para saber o que fazer.
   */
  static async requestEmailVerification(req, res) {
    try {
      const user = await User.findById(req.user.userId);
      if (!user) {
        return res.status(404).json(createErrorResponse(req.t('auth.userNotFound')));
      }

      const email = User.normalizeEmail(user.email);
      if (!email) {
        return res.status(400).json(createErrorResponse(req.t('auth.emailMissing')));
      }
      if (user.email_verified_at) {
        return res.json(createResponse(req.t('auth.emailAlreadyVerified'), { verified: true }));
      }

      const enviado = await enviarBilhete({
        req,
        purpose: AuthTicket.PURPOSES.EMAIL_VERIFICATION,
        userId: user.id,
        tenantId: Number(req.tenantId),
        email,
        rota: '/verify-email',
        assunto: 'auth.emailVerifyMailSubject',
        corpo: 'auth.emailVerifyMailBody'
      });
      if (!enviado) {
        return res.status(503).json(createErrorResponse(req.t('auth.emailVerifyUnavailable')));
      }

      return res.json(createResponse(req.t('auth.emailVerifySent'), { verified: false }));
    } catch (error) {
      console.error('Email verification request error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  /**
   * O link aberto carimba o endereço como provado.
   *
   * Pública de propósito: a mensagem costuma ser lida no celular, onde não há
   * sessão do painel, e exigir login antes de confirmar transformaria uma
   * confirmação num pedido de senha — que é exatamente a forma de um phishing.
   * O bilhete é a credencial, vale uma vez e só carimba o endereço que ele
   * nomeia.
   */
  static async confirmEmailVerification(req, res) {
    try {
      const token = String(req.body?.token ?? '').trim();
      if (!token) {
        return res.status(400).json(createErrorResponse(req.t('auth.emailVerifyRequired')));
      }

      const recusa = () => res.status(404).json(
        createErrorResponse(req.t('auth.emailVerifyInvalid'))
      );

      const ticket = await AuthTicket.redeem({
        token,
        purpose: AuthTicket.PURPOSES.EMAIL_VERIFICATION,
        tenantId: req.tenantId
      });
      if (!ticket) return recusa();

      // `markEmailVerified` só carimba se o endereço da conta AINDA for este —
      // ver o porquê lá. Um link de um endereço já trocado não carimba nada.
      if (!(await User.markEmailVerified(ticket.user_id, ticket.email))) return recusa();

      const user = await User.findById(ticket.user_id);
      await runInTenant(Number(ticket.tenant_id), () => AuditLog.record({
        action: AuditLog.ACTIONS.LOGIN_EMAIL_VERIFIED,
        actorUserId: ticket.user_id,
        actorUsername: user?.username ?? null,
        subjectType: 'user',
        subjectId: ticket.user_id,
        detail: { email: ticket.email },
        ip: req.ip ?? null
      }));

      return res.json(createResponse(req.t('auth.emailVerified'), { email: ticket.email }));
    } catch (error) {
      console.error('Email verification confirm error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }
}

export default AuthController;
