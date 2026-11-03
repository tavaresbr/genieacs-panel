import bcrypt from 'bcryptjs';
import ImpersonationTicket from '../models/ImpersonationTicket.js';
import AuthTicket from '../models/AuthTicket.js';
import PlatformAdmin from '../models/PlatformAdmin.js';
import User from '../models/User.js';
import { acceptsIdentifier, canHoldSession, LOGIN_REQUIRES_EMAIL } from '../config/login.js';
import TenantUser from '../models/TenantUser.js';
import { IS_SAAS } from '../config/edition.js';
import { CONSOLE_AUDIENCE, PANEL_AUDIENCE, decodeOwnSessionToken, generateConsoleTokens, generateImpersonationToken, generateTokens, openMembership, resolveMembership, verifyToken } from '../middleware/auth.js';
import RefreshToken, { describeUserAgent } from '../models/RefreshToken.js';
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from '../middleware/sessionCookie.js';
import { openConsoleSession, openPanelSession } from '../services/panelSessionService.js';
import { createResponse, createErrorResponse, isValidEmail, usernameLengthProblem } from '../utils/helpers.js';
import Tenant from '../models/Tenant.js';
import PlatformAudit from '../models/PlatformAudit.js';
import { getDb } from '../config/database.js';
import { seedDefaults } from '../config/seed.js';
import { slugProblem } from '../utils/slug.js';
import { hostMatchesTenant, usesTenantSubdomains } from '../middleware/tenantResolver.js';
import AuditLog from '../models/AuditLog.js';
import { runInTenant } from '../config/tenantContext.js';
import { recordPanelActivity } from '../services/dashboardSchedule.js';
import { mailTransport, panelUrlFor } from '../services/mail/index.js';
import MfaService, { mfaEnabled } from '../services/mfaService.js';
import AccountLockout from '../models/AccountLockout.js';
import { PRODUCT_NAME } from '../config/brand.js';
import Plan from '../models/Plan.js';
import PlatformNotifyService from '../services/platformNotifyService.js';
import PlatformAlertService from '../services/platformAlertService.js';
import { normalizeTaxId, isValidCnpj } from '../utils/taxId.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';
import { translate } from '../i18n/index.js';
import { DEFAULT_LOCALE } from '../i18n/config.js';
import ReferralService from '../services/referralService.js';
import { newPasswordProblem } from '../utils/passwordPolicy.js';
import AffiliateService from '../services/affiliateService.js';

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
  if (!base) {
    // Sem isto a falha é muda: a rota responde 200 — tem que responder, senão
    // vira oráculo —, nenhuma mensagem sai, e não há onde ler o porquê. Num
    // deploy de host único o endereço do painel não se deduz de subdomínio
    // nenhum, e `PUBLIC_BASE_URL` é a única fonte que resta.
    console.warn(
      `Cannot send ${purpose} ticket: no panel URL for tenant ${tenantId}. ` +
      'Set PUBLIC_BASE_URL (deployments without TENANT_BASE_DOMAIN) or TENANT_BASE_DOMAIN.'
    );
    return false;
  }

  const { token } = await AuthTicket.create({ purpose, userId, tenantId, email });
  const nome = tenant?.name || PRODUCT_NAME;
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
    return openMembership(userId, id);
  }
  // O primeiro provedor que recebe a pessoa. Um suspenso não recebe ninguém
  // (salvo quem opera a plataforma), e escolhê-lo aqui trancaria do lado de
  // fora quem também trabalha num provedor ativo.
  const vinculos = await TenantUser.listForUserWithTenant(userId);
  const ativo = vinculos.find((vinculo) => vinculo.status === 'active');
  return openMembership(userId, (ativo ?? vinculos[0])?.id);
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
 * Para onde esta pessoa pode entrar, quando o endereço não decide.
 *
 * Num deploy com subdomínio por provedor o host responde isto sozinho, e nada
 * aqui roda. Sem domínio-base — todos os provedores no mesmo endereço, a
 * separação vindo do login — a pergunta é legítima e pode ter mais de uma
 * resposta: os provedores em que a pessoa trabalha, mais o console se ela
 * opera a plataforma.
 *
 * Quem tem um destino só não é perguntado. Quem tem vários era mandado, em
 * silêncio, para o vínculo mais antigo — o que é uma regra defensável e uma
 * escolha invisível, e invisível é o problema: um consultor que atende dois
 * ISPs não tinha como pedir o outro.
 */
async function destinosDoLogin(user) {
  const tenants = await TenantUser.listForUserWithTenant(user.id);
  const console = IS_SAAS && (await PlatformAdmin.has(user.id));
  return { tenants, console, total: tenants.length + (console ? 1 : 0) };
}

/** A resposta de quem entrou no console: sem provedor e sem papel, como a sessão. */
async function respostaDoConsole(req, res, user) {
  const token = await openConsoleSession(req, res, user);
  // Sem `marcarAtividade`: aquilo marca atividade DE UM PROVEDOR, e esta
  // sessão não tem um.
  return res.json(
    createResponse(req.t('auth.loginSuccess'), {
      user: {
        id: user.id,
        username: user.username,
        email: user.email ?? null,
        emailVerified: Boolean(user.email_verified_at),
        // Sem papel e sem provedor, como a sessão. `platform: true` para a tela
        // não ter que deduzir isso de um `tenantId` nulo.
        role: null,
        tenantId: null,
        platform: true,
        isPlatformAdmin: true,
        createdAt: user.created_at,
        updatedAt: user.updated_at
      },
      // O refresh não vem no corpo: está no cookie `HttpOnly` (0129).
      token
    })
  );
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
      // Com subdomínio por provedor, ou no endereço da plataforma de um deploy
      // de endereço único (`PLATFORM_EXTRA_HOSTS`). No endereço compartilhado
      // dos painéis, não: ali quem chega já é de algum provedor.
      if (!usesTenantSubdomains() && !req.platformHost) {
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
      const nomeRuim = usernameLengthProblem(username, 'auth.signupInvalid');
      if (nomeRuim) {
        return res.status(400).json(createErrorResponse(req.t(nomeRuim)));
      }
      // A regra da senha nova (10+, fora das comuns, diferente do login); ver
      // `utils/passwordPolicy.js`. O tamanho mantém a frase de antes.
      const senhaRuim = newPasswordProblem(password, { username, email }, { lengthKey: 'auth.signupInvalid' });
      if (senhaRuim) {
        return res.status(400).json(createErrorResponse(req.t(senhaRuim.key), null, senhaRuim.code));
      }
      if (!email || !isValidEmail(email)) {
        return res.status(400).json(createErrorResponse(req.t('auth.emailInvalid')));
      }
      // O que a página pública acrescenta, tudo opcional: o plano escolhido na
      // vitrine, o CNPJ (que já vira o cadastro fiscal) e o WhatsApp do dono.
      //
      // Plano que não está à venda é ignorado, e não recusado: o link com
      // `?plano=` pode ser de ontem, e o provedor ainda ganha o teste padrão.
      const chosenPlan = body.planCode ? await Plan.findPublicByCode(body.planCode) : null;
      const taxId = body.taxId ? normalizeTaxId(body.taxId) : '';
      if (taxId && !isValidCnpj(taxId)) {
        return res.status(400).json(createErrorResponse(req.t('tenant.billingTaxIdInvalid')));
      }
      const phone = body.phone ? normalizarTelefoneBr(body.phone) : '';
      if (body.phone && !phone) {
        return res.status(400).json(createErrorResponse(req.t('auth.signupPhoneInvalid')));
      }
      const fiscal = {};
      if (taxId) fiscal.billing_tax_id = taxId;
      if (phone) fiscal.billing_phone = phone;
      if (taxId) {
        const legalName = String(body.legalName ?? '').trim().slice(0, 160);
        if (legalName) fiscal.billing_legal_name = legalName;
        const cidade = String(body.city ?? '').trim().slice(0, 80);
        if (cidade) fiscal.billing_city = cidade;
        const uf = String(body.state ?? '').trim().toUpperCase();
        if (/^[A-Z]{2}$/.test(uf)) fiscal.billing_state = uf;
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
      let referredBy = null;
      let affiliateId = null;
      try {
        await getDb().transaction(async (trx) => {
          tenantId = await Tenant.create({ slug, name }, trx);
          // Só o provedor que acabou de nascer. A passagem completa custa
          // dezessete consultas por provedor existente, e esta é uma rota
          // pública — ver `seedDefaults`.
          if (Object.keys(fiscal).length) {
            await trx('tenants').where({ id: tenantId }).update(fiscal);
          }
          await seedDefaults(trx, { tenantIds: [tenantId], planId: chosenPlan?.id ?? null });
          // A indicação (0106): `?ref=CÓDIGO` no link de quem indicou. Código
          // inválido e a indicação de si mesmo são ignorados — e uma falha
          // aqui também, num savepoint: a indicação nunca derruba o cadastro.
          // O afiliado (0126): `?aff=A-CÓDIGO`. Uma atribuição por cadastro —
          // com o afiliado ligado, o `?ref=` do mesmo link não paga outra
          // recompensa. Num savepoint, pela mesma regra da indicação.
          if (body.affiliateCode) {
            try {
              affiliateId = await trx.transaction((sp) => AffiliateService.attachAtSignup({
                trx: sp, tenantId, code: body.affiliateCode, email, taxId
              }));
            } catch (error) {
              console.warn(`Signup: the affiliate code was ignored: ${String(error?.message).replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 300)}`);
              affiliateId = null;
            }
          }
          if (body.referralCode && !affiliateId) {
            try {
              referredBy = await trx.transaction((sp) => ReferralService.attachAtSignup({
                trx: sp, tenantId, code: body.referralCode, email, taxId
              }));
            } catch (error) {
              console.warn(`Signup: the referral code was ignored: ${error.message}`);
              referredBy = null;
            }
          }
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
        detail: {
          via: 'signup', ownerUserId: userId, ...(referredBy ? { referredBy } : {}), ...(affiliateId ? { affiliateId } : {})
        },
        ip: req.ip ?? null
      });
      // O alerta da indicação para quem opera a plataforma (0112): um por
      // provedor indicado. Depois da transação do cadastro, e nunca lança.
      if (referredBy) {
        const quem = await Tenant.findById(referredBy).catch(() => null);
        await PlatformAlertService.enqueue('referral_signup', {
          tenantId,
          dedupeKey: String(tenantId),
          payload: { referrer: quem?.name ?? null, referrerSlug: quem?.slug ?? null }
        });
      }

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

      // Sem subdomínio, o painel do provedor novo é o endereço compartilhado
      // (`PUBLIC_BASE_URL`), onde ele entra com o login que acabou de criar.
      const panelUrl = panelUrlFor(tenant);

      // Boas-vindas pelo WhatsApp da plataforma, e o aviso para a equipe.
      // Fora do caminho da resposta: nenhum dos dois pode atrasar nem
      // derrubar o cadastro.
      if (phone) {
        PlatformNotifyService.sendWhatsapp(phone, translate(DEFAULT_LOCALE, 'auth.signupWelcomeWhatsapp', {
          provider: tenant.name,
          product: PRODUCT_NAME,
          link: panelUrl || '',
          username
        })).catch(() => {});
      }
      PlatformNotifyService.notifyTeam({
        subject: translate(DEFAULT_LOCALE, 'auth.signupTeamSubject', { provider: tenant.name }),
        text: translate(DEFAULT_LOCALE, 'auth.signupTeamBody', {
          provider: tenant.name,
          slug: tenant.slug,
          email,
          phone: phone || '-',
          taxId: taxId || '-',
          plan: chosenPlan?.code || '-'
        })
      }).catch(() => {});

      return res.status(201).json(createResponse(req.t('auth.signupCreated'), {
        tenant: { slug: tenant.slug, name: tenant.name },
        panelUrl,
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

      // Contra o provedor que o HOST NOMEIA, pela mesma regra e pela mesma
      // função que o replay de token usa — `hostMatchesTenant`. Era `req.tenantId`,
      // que numa instalação sem domínio-base é o PRIMEIRO provedor da tabela e
      // não uma porta: ali um bilhete de qualquer outro provedor era recusado
      // como se fosse forjado, e a personificação simplesmente não funcionava
      // fora do primeiro. Onde nenhum host nomeia provedor não existe porta
      // errada onde gastar o bilhete, que é a única coisa que esta conferência
      // tem para impedir.
      if (!hostMatchesTenant(req, ticket.tenant_id)) return recusa();

      const tenant = await Tenant.findPublicById(ticket.tenant_id);
      if (!tenant) return recusa();

      // `runInTenant` do provedor DO BILHETE, e não o escopo em que o request
      // entrou: sem domínio-base esse escopo é o primeiro provedor, e a linha
      // "entraram no meu painel" ficaria arquivada no ISP errado — exatamente
      // a pergunta que esta trilha existe para responder.
      await runInTenant(Number(ticket.tenant_id), () => AuditLog.record({
        action: AuditLog.ACTIONS.PLATFORM_IMPERSONATED,
        actorUserId: platformUser.id,
        actorUsername: platformUser.username,
        actorKind: 'platform',
        subjectType: 'tenant',
        subjectId: ticket.tenant_id,
        detail: { ticketId: ticket.id },
        ip: req.ip ?? null
      }));

      const token = generateImpersonationToken(platformUser, ticket.tenant_id);

      return res.json(createResponse(req.t('auth.impersonationStarted'), {
        user: {
          id: platformUser.id,
          username: platformUser.username,
          email: platformUser.email ?? null,
          role: 'admin',
          tenantId: Number(ticket.tenant_id),
          // Falso de propósito, e não é contradição: dentro de uma
          // personificação o console não é alcançável — `requirePlatformAdmin`
          // recusa esta sessão. Dizer `true` acenderia um menu cujas rotas
          // respondem 404 a ela.
          isPlatformAdmin: false,
          // Mesma forma que `hydrateImpersonation` devolve, porque esta
          // resposta e o `/api/auth/user` de depois de um F5 alimentam a mesma
          // faixa e têm que dizer a mesma coisa.
          impersonation: {
            platformUsername: platformUser.username,
            tenantName: tenant.name,
            tenantSlug: tenant.slug
          },
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
      const { username, password, tenantId, destination, totpCode } = req.body;

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

      // A trava por conta, ANTES de qualquer conferência. Conta que existe é
      // contada pelo id — nome e e-mail são o mesmo alvo e dividem os dez
      // palpites —; login inventado é contado pelo que foi digitado, e trava
      // do mesmo jeito, para que a trava não diga quem tem conta.
      const tentativa = await AccountLockout.attempt(
        user ? AccountLockout.forUser(user.id) : AccountLockout.forIdentifier(normalizedUsername)
      );
      if (!tentativa.allowed) {
        return AccountLockout.refuse(req, res, tentativa, password, { user, via: 'login' });
      }

      if (!user) {
        await bcrypt.compare(String(password), DUMMY_PASSWORD_HASH);
        await AccountLockout.failed(req, tentativa, { via: 'login' });
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
        await AccountLockout.failed(req, tentativa, { user, via: 'login' });
        return res.status(401).json(
          createErrorResponse(req.t('auth.invalidCredentials'))
        );
      }

      // O segundo fator, ANTES de qualquer ramo — console, escolha de
      // provedor, provedor. Cada um desses emite sessão ou diz para onde a
      // pessoa pode ir, e as duas coisas são o que a segunda etapa protege.
      //
      // Só chega aqui quem acertou a senha: senha errada é o 401 de sempre,
      // sem pista de 2FA. Pedir o código revela que a senha estava certa, e é
      // o preço de toda segunda etapa — o que ela protege é justamente o caso
      // em que a senha já vazou.
      let segundoFator = null;
      // Código errado conta na mesma trava da senha, e a senha certa que veio
      // junto NÃO zera nada: o 2FA existe para o caso em que a senha vazou, e
      // zerar a contagem a cada senha certa daria palpites infinitos nos seis
      // dígitos. A contagem só some quando a sessão sai.
      const codigoInvalido = async () => {
        await AccountLockout.failed(req, tentativa, { user, via: 'login_mfa' });
        return res.status(401).json(
          createErrorResponse(req.t('auth.mfaInvalid'), null, 'mfa_invalid')
        );
      };
      if (mfaEnabled(user)) {
        if (totpCode === undefined || totpCode === null || totpCode === '') {
          return res.status(401).json(createErrorResponse(req.t('auth.mfaRequired'), null, 'mfa_required'));
        }
        // Conferido aqui, GASTO só onde a sessão nasce (`gastarCodigo`): a
        // resposta pode ser "em qual provedor?", e a tela reenvia o mesmo
        // código com a escolha.
        segundoFator = await MfaService.verifySecondFactor(user, totpCode, { consume: false });
        if (!segundoFator.ok) return codigoInvalido();
      }
      // Gasta o código no instante de emitir a sessão. Falha aqui é a mesma
      // entrada chegando duas vezes ao mesmo tempo: só uma passa.
      const gastarCodigo = async () => !segundoFator
        || (await MfaService.verifySecondFactor(user, totpCode)).ok;

      // O login do CONSOLE, no endereço da própria plataforma.
      //
      // Entra aqui, ANTES da linha de baixo, e a ordem é a decisão: ali o
      // provedor sai de `req.hostTenantId ?? tenantId`, e no ápice o primeiro é
      // nulo — o `tenantId` do CORPO escolheria um provedor a partir do host
      // que não nomeia nenhum.
      //
      // Quem não está no cadastro da plataforma recebe 401 com o corpo idêntico
      // ao de senha errada. Distinguir transformaria este login num oráculo que
      // responde "este login é de quem opera a plataforma" — a lista mais curta
      // e mais valiosa do deploy, e a lista de alvos de um phishing bem-feito.
      // A leitura do cadastro vem DEPOIS do bcrypt de propósito: invertida, o
      // tempo de resposta separaria "conta existe, fora do cadastro" de "conta
      // não existe" para quem cronometrasse.
      if (req.platformHost) {
        if (!canHoldSession(user) || !(await PlatformAdmin.has(user.id))) {
          return res.status(401).json(
            createErrorResponse(req.t('auth.invalidCredentials'))
          );
        }
        if (!(await gastarCodigo())) return codigoInvalido();
        await AccountLockout.clear(tentativa.subject);
        return respostaDoConsole(req, res, user);
      }

      // O console PEDIDO, num deploy que não tem endereço de plataforma.
      //
      // Onde há domínio-base o console tem porta própria e é ela que decide —
      // por isso `usesTenantSubdomains()` aqui: aceitar o pedido lá abriria, no
      // host de um provedor, a sessão que `tokenMatchesHost` recusa um instante
      // depois. A recusa é a de sempre, idêntica à de senha errada, porque
      // distinguir diria quem está no cadastro da plataforma.
      if (destination === 'console' && !usesTenantSubdomains()) {
        if (!IS_SAAS || !canHoldSession(user) || !(await PlatformAdmin.has(user.id))) {
          return res.status(401).json(
            createErrorResponse(req.t('auth.invalidCredentials'))
          );
        }
        if (!(await gastarCodigo())) return codigoInvalido();
        await AccountLockout.clear(tentativa.subject);
        return respostaDoConsole(req, res, user);
      }

      // Com mais de um PROVEDOR e ninguém nomeado, PERGUNTA.
      //
      // A pergunta é sobre ambiguidade de verdade — a pessoa trabalha em dois
      // ISPs e o endereço não diz qual —, e só isso. O console NÃO provoca a
      // pergunta, embora vá na lista quando ela acontece: quem opera a
      // plataforma quase sempre também trabalha num provedor, e fazer disso um
      // seletor em todo login poria uma escolha na frente de quem só quer o
      // painel de sempre. Para o console há o caminho explícito acima, que a
      // tela oferece ao lado do formulário.
      //
      // Depois do `bcrypt`, nunca antes: quem erra a senha recebe o 401 de
      // sempre, sem lista. Quem acerta já poderia entrar em cada um desses
      // provedores, então nomeá-los não entrega nada que a senha já não
      // entregasse. `409` e não `200` para que um cliente antigo, que só sabe
      // ler `token`, falhe em vez de seguir achando que entrou.
      const nomeado = req.hostTenantId ?? tenantId;
      if (nomeado === undefined || nomeado === null || nomeado === '') {
        const destinos = await destinosDoLogin(user);
        if (destinos.tenants.length > 1) {
          // Os destinos no TOPO do corpo, e não dentro de `data`: o cliente de
          // API encaminha campo nomeado num erro e descarta o `data` inteiro —
          // é o mesmo desenho do 409 de valor curto e do 402 de limite de
          // plano. O `code` é o que a tela liga ao segundo passo, sem depender
          // da frase traduzida.
          return res.status(409).json({
            ...createErrorResponse(req.t('auth.chooseDestination')),
            code: 'choose_destination',
            destinations: {
              tenants: destinos.tenants.map((d) => ({
                id: Number(d.id), name: d.name, slug: d.slug, status: d.status
              })),
              console: destinos.console
            }
          });
        }
        // Quem só tem o console — opera a plataforma e não trabalha em provedor
        // nenhum — entra nele sem ser perguntado: é o único destino que existe,
        // e a alternativa seria o 401 de "trabalha para ninguém".
        if (destinos.tenants.length === 0 && destinos.console) {
          if (!(await gastarCodigo())) return codigoInvalido();
          await AccountLockout.clear(tentativa.subject);
          return respostaDoConsole(req, res, user);
        }
      }

      // The host wins over the body. Where providers have subdomains, the
      // address the person typed is the provider they mean, and letting a
      // `tenantId` in the payload override it would mean the login screen of
      // one ISP mints a session for another — refused a moment later by the
      // host check in `authenticateToken`, but only after confirming to the
      // caller that the credentials are good for SOMEBODY.
      const membership = await membershipForLogin(user.id, nomeado);

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

      if (!(await gastarCodigo())) return codigoInvalido();
      // A sessão sai: a prova terminou, e a contagem de tentativas some.
      await AccountLockout.clear(tentativa.subject);
      const accessToken = await openPanelSession(req, res, user, membership);
      await marcarAtividade(membership.tenant_id);
      // Entrar com um código de recuperação deixa linha na trilha do provedor
      // em que a sessão abriu: é o sinal de que o celular sumiu, e o dono quer
      // saber. `fromRequest` não lança.
      if (segundoFator?.via === 'recovery') {
        await runInTenant(membership.tenant_id, () => AuditLog.fromRequest(
          // `req.ip` é um getter do Express: espalhar `req` o perderia.
          { ip: req.ip, user: { userId: user.id, username: user.username } },
          { action: AuditLog.ACTIONS.USER_MFA_RECOVERY_USED, subjectType: 'user', subjectId: String(user.id) }
        ));
      }

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
            // O provedor exige o 2FA e esta pessoa ainda não ativou: a tela vai
            // direto para a ativação. É o mesmo que a sessão vai dizer a cada
            // requisição — aqui só poupa a tela de descobrir pelo primeiro 403.
            mfaEnrollmentRequired: !mfaEnabled(user) && (await Tenant.requiresMfa(membership.tenant_id)),
            createdAt: user.created_at,
            updatedAt: user.updated_at
          },
          // Só o token de acesso: o refresh foi para o cookie (0129).
          token: accessToken
        })
      );
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json(
        createErrorResponse(req.t('common.internalError'), error.message)
      );
    }
  }

  /**
   * As rotas do login em duas etapas, todas sobre a PRÓPRIA conta de quem está
   * na sessão — por isso nenhuma pede capacidade além de estar logado, como
   * trocar a própria senha.
   */
  static mfaError(req, res, error, label) {
    if (error.translationKey) {
      return res.status(error.status || 400).json(
        createErrorResponse(req.t(error.translationKey), null, error.code || null)
      );
    }
    console.error(`${label} error:`, error);
    return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
  }

  /**
   * Tokens novos para a sessão que acabou de mudar o próprio segundo fator.
   *
   * Ativar, desligar e trocar os códigos sobem o `token_version` — toda sessão
   * aberta antes cai. Menos a de quem pediu: ela provou agora mesmo o que a
   * mudança exige, e derrubá-la jogaria a pessoa no login no meio da tela do
   * 2FA, com os códigos de recuperação ainda por anotar. Cunhados do usuário
   * RELIDO, que já carrega a versão nova, e na mesma forma da sessão que chamou
   * — console para o console, o provedor e o papel já hidratados para o painel.
   * A personificação não chega aqui: `/api/auth/` é escrita recusada a ela.
   */
  static async mfaFreshTokens(req, res) {
    const user = await User.findById(req.user.userId);
    if (!user) return {};
    // A família DESTA sessão passa para a versão nova e segue viva, com o mesmo
    // cookie; as outras ficam na versão antiga e caem na próxima renovação. Um
    // token de antes desta versão (sem família) ganha uma família nova aqui.
    if (req.user.sessionId) {
      await RefreshToken.adoptVersion(req.user.sessionId, user.id, user.token_version);
      const opcoes = { sessionId: req.user.sessionId };
      const { accessToken } = req.user.platform
        ? generateConsoleTokens(user, opcoes)
        : generateTokens(user, { tenant_id: req.user.tenantId, role: req.user.role }, opcoes);
      return { token: accessToken };
    }
    const token = req.user.platform
      ? await openConsoleSession(req, res, user)
      : await openPanelSession(req, res, user, { tenant_id: req.user.tenantId, role: req.user.role });
    return { token };
  }

  static async mfaStatus(req, res) {
    try {
      return res.json(createResponse(null, await MfaService.status(req.user.userId)));
    } catch (error) {
      return AuthController.mfaError(req, res, error, 'MFA status');
    }
  }

  static async mfaSetup(req, res) {
    try {
      return res.json(createResponse(null, await MfaService.setup(req.user.userId)));
    } catch (error) {
      return AuthController.mfaError(req, res, error, 'MFA setup');
    }
  }

  static async mfaEnable(req, res) {
    try {
      const result = await MfaService.enable(req.user.userId, req.body?.code);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.USER_MFA_ENABLED, subjectType: 'user', subjectId: String(req.user.userId)
      });
      return res.json(createResponse(req.t('auth.mfaEnabled'), {
        ...result, ...(await AuthController.mfaFreshTokens(req, res))
      }));
    } catch (error) {
      return AuthController.mfaError(req, res, error, 'MFA enable');
    }
  }

  static async mfaDisable(req, res) {
    try {
      await MfaService.disable(req.user.userId, req.body?.password, req.body?.code);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.USER_MFA_DISABLED, subjectType: 'user', subjectId: String(req.user.userId)
      });
      return res.json(createResponse(req.t('auth.mfaDisabled'), {
        enabled: false, ...(await AuthController.mfaFreshTokens(req, res))
      }));
    } catch (error) {
      return AuthController.mfaError(req, res, error, 'MFA disable');
    }
  }

  static async mfaRegenerateRecovery(req, res) {
    try {
      const result = await MfaService.regenerateRecoveryCodes(req.user.userId, req.body?.password, req.body?.code);
      await AuditLog.fromRequest(req, {
        action: AuditLog.ACTIONS.USER_MFA_RECOVERY_REGENERATED, subjectType: 'user', subjectId: String(req.user.userId)
      });
      return res.json(createResponse(req.t('auth.mfaRecoveryRegenerated'), {
        ...result, ...(await AuthController.mfaFreshTokens(req, res))
      }));
    } catch (error) {
      return AuthController.mfaError(req, res, error, 'MFA recovery codes');
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

      // Conta NOVA nasce com e-mail, sem exceção — e a primeira de todas menos
      // ainda: é a única do install que não tem quem a conserte depois, porque
      // é ela quem cadastra as outras. Contas sem endereço existem só como
      // herança de antes desta versão.
      const email = User.normalizeEmail(req.body?.email);

      const senhaRuim = newPasswordProblem(String(password), { username: normalizedUsername, email });
      if (senhaRuim) {
        return res.status(400).json(createErrorResponse(req.t(senhaRuim.key), null, senhaRuim.code));
      }

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
      const user = { id: userId, username: normalizedUsername, token_version: 0 };

      const accessToken = await openPanelSession(req, res, user, { tenant_id: tenantId, role });

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
          token: accessToken
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
          // Só se está ligado — o segredo e os códigos nunca saem daqui.
          mfaEnabled: Boolean(user.totp_enabled_at),
          // Da sessão, que acabou de ler a exigência do provedor e a pessoa.
          mfaEnrollmentRequired: Boolean(req.user.mfaEnrollmentRequired),
          // From the session rather than from the row, for the same reason the
          // login response reports it that way: this is the answer the panel
          // rebuilds its menus from after a page reload, and `users.role` is
          // not what this session is authorised with.
          role: req.user.role,
          tenantId: req.user.tenantId,
          // O provedor DESTA sessão, pelo token — o que o topo do menu mostra.
          // O perfil público (`/api/public/tenant`) é resolvido pelo host, e num
          // host único ele nomeia sempre o primeiro provedor: um nome errado
          // exatamente onde a tela diz "você está no painel de X". Nulo na
          // sessão do console, que não é de provedor nenhum.
          tenant: req.user.platform || !req.user.tenantId
            ? null
            : await Tenant.findPublicById(req.user.tenantId)
              .then((row) => (row ? { slug: row.slug ?? null, name: row.name } : null)),
          // Presente só na sessão do console, e é o que diz à tela que esta
          // sessão não tem provedor — em vez de ela deduzir isso de um
          // `tenantId` nulo, que é a dedução que um dia alguém faz errado.
          platform: req.user.platform ? true : undefined,
          // Numa personificação isto é falso mesmo sendo a pessoa do cadastro
          // da plataforma: dentro dela o console não é alcançável, e um `true`
          // aqui acenderia um menu cujas rotas respondem 404 a esta sessão.
          // Mesma resposta que o resgate deu; esta rota é a que a tela relê
          // depois de um F5, e as duas têm que dizer a mesma coisa.
          isPlatformAdmin: req.user.impersonation
            ? false
            // A sessão do console só existe porque a hidratação acabou de ler o
            // cadastro: reler aqui responderia a mesma coisa com uma consulta a
            // mais.
            : (req.user.platform ? true : await holdsControlPlane(user.id)),
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

  /**
   * "Sair" encerra ESTE aparelho, e só ele (0129). Antes subia o
   * `token_version` e derrubava a pessoa em todo lugar; "sair de todos" é
   * agora `POST /api/auth/sessions/revoke-all`.
   *
   * Qual família encerrar vem, nesta ordem:
   *
   * 1. do `sid` do token de acesso que a tela manda — mesmo vencido: a
   *    assinatura prova de quem é, e encerrar é a direção segura. É o que
   *    resolve a saída que chega atrasada: a tela já esqueceu o token e outra
   *    pessoa entrou na mesma aba, e o cookie agora é da sessão NOVA — revogar
   *    pelo cookie derrubaria quem acabou de entrar;
   * 2. do cookie, quando não há token.
   *
   * A sessão que vem do refresh ANTIGO sobe o `token_version`, como o "Sair"
   * de antes: o token de acesso de antes desta versão (sem `sid`), e a família
   * convertida dele (`RefreshToken.isLegacyFamily`). O JWT sem estado de onde
   * ela veio pode ter ficado em outra aba, ou numa cópia, e só a versão o
   * derruba — o custo é sair de todos os aparelhos, uma vez, na transição.
   *
   * O cookie só é apagado quando é da família encerrada (ou não serve mais).
   * Sempre 200: sair de uma sessão que já não existe é ter saído.
   */
  static async logout(req, res) {
    return AuthController.logoutKind(req, res, 'panel');
  }

  static async consoleLogout(req, res) {
    return AuthController.logoutKind(req, res, 'console');
  }

  static async logoutKind(req, res, kind) {
    try {
      const header = req.headers.authorization;
      const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : null;
      const decoded = bearer ? decodeOwnSessionToken(bearer) : null;
      // A personificação não sai por aqui: a conta é de quem personifica, e o
      // cookie do navegador é a sessão dela no console (ou no painel). A aba
      // da personificação só esquece o próprio token.
      if (decoded?.impersonation) {
        return res.status(403).json({
          success: false, message: req.t('auth.impersonationReadOnly'), code: 'impersonation_read_only'
        });
      }
      const raw = readRefreshCookie(req, kind);
      const row = raw ? await RefreshToken.findByRaw(raw) : null;
      const sid = typeof decoded?.sid === 'string' ? decoded.sid : null;
      if (sid) {
        if (await RefreshToken.isLegacyFamily(sid, decoded.userId)) {
          await AuthController.endLegacySession(decoded.userId, decoded.tokenVersion);
        }
        await RefreshToken.revokeOwnFamily(decoded.userId, sid);
        if (!row || row.family_id === sid || row.revoked_at) clearRefreshCookie(req, res, kind);
      } else if (decoded) {
        // Um token de acesso de antes da 0129 (sem `sid`): não há família a
        // encerrar, e o refresh que o acompanha é o JWT sem estado.
        await AuthController.endLegacySession(decoded.userId, decoded.tokenVersion);
        if (row) await RefreshToken.revokeFamily(row.family_id);
        clearRefreshCookie(req, res, kind);
      } else {
        if (row && !row.revoked_at && await RefreshToken.isLegacyFamily(row.family_id, row.user_id)) {
          await AuthController.endLegacySession(row.user_id, row.token_version);
        }
        if (row) await RefreshToken.revokeFamily(row.family_id);
        clearRefreshCookie(req, res, kind);
      }
      return res.json(createResponse(req.t('auth.logoutSuccess')));
    } catch (error) {
      console.error('Logout error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * O "Sair" de uma sessão do refresh antigo: sobe o `token_version` (o JWT
   * sem estado morre) e encerra as famílias da pessoa — mas só se quem pede
   * está na versão ATUAL dela. Um token de uma versão já morta não serve para
   * derrubar as sessões de hoje.
   */
  static async endLegacySession(userId, tokenVersion) {
    const user = await User.findById(userId);
    if (!user || Number(user.token_version || 0) !== Number(tokenVersion || 0)) return false;
    await User.revokeSessions(user.id);
    await RefreshToken.revokeAllForUser(user.id);
    return true;
  }

  /** O 401 de toda renovação recusada: o cookie sai junto, e a tela vai ao login. */
  static refreshRefused(req, res, kind, code = 'refresh_invalid') {
    clearRefreshCookie(req, res, kind);
    return res.status(401).json({
      ...createErrorResponse(req.t(code === 'refresh_required' ? 'auth.refreshTokenRequired' : 'auth.refreshSessionInvalid')),
      code
    });
  }

  /**
   * Reuso: um refresh já trocado voltou depois da folga. A família já foi
   * revogada pelo modelo; aqui fica a linha na trilha — do provedor, para a
   * sessão de painel (o dono quer saber que um aparelho da equipe vazou); da
   * plataforma, para a do console.
   */
  static async recordReuse(req, row, user) {
    const detail = { family: String(row.family_id).slice(0, 8), userAgent: describeUserAgent(req.get('user-agent')) };
    if (row.audience === CONSOLE_AUDIENCE) {
      await PlatformAudit.record({
        action: PlatformAudit.ACTIONS.SESSION_REFRESH_REUSE,
        actorUserId: user?.id ?? row.user_id,
        actorUsername: user?.username ?? null,
        detail,
        ip: req.ip ?? null
      });
      return;
    }
    if (!row.tenant_id) return;
    await runInTenant(Number(row.tenant_id), () => AuditLog.record({
      action: AuditLog.ACTIONS.SESSION_REFRESH_REUSE,
      actorUserId: user?.id ?? row.user_id,
      actorUsername: user?.username ?? null,
      subjectType: 'user',
      subjectId: String(row.user_id),
      detail,
      ip: req.ip ?? null
    })).catch(() => false);
  }

  /**
   * Renova a sessão do painel pelo cookie (0129). Por uma versão, também aceita
   * o refresh ANTIGO no corpo — o JWT sem estado que o frontend anterior
   * guardava no `localStorage` — e o converte numa família nova com cookie; o
   * frontend novo faz isso uma vez, na primeira carga, e apaga o JWT.
   *
   * 401 para toda recusa (cookie ausente, inválido, vencido, revogado, reuso):
   * aqui não há sessão a renovar, e a tela vai ao login. O 403 `invalid_token`
   * continua sendo o das rotas comuns, que é o que dispara a renovação.
   */
  static async refreshToken(req, res) {
    try {
      const raw = readRefreshCookie(req, 'panel');
      if (!raw) {
        const legacy = req.body?.refreshToken;
        if (legacy !== undefined && legacy !== null && legacy !== '') {
          return await AuthController.migrateLegacyRefresh(req, res, legacy);
        }
        return AuthController.refreshRefused(req, res, 'panel', 'refresh_required');
      }
      return await AuthController.rotateCookie(req, res, raw, 'panel');
    } catch (error) {
      console.error('Refresh token error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * A renovação do console: o mesmo mecanismo, com o cookie e o `Path` dele.
   * Só no endereço da plataforma, onde ele existe (`platformHostOnly` na rota);
   * num deploy sem domínio-base o console divide o endereço com os painéis,
   * como `tokenMatchesHost` já aceita.
   */
  static async consoleRefreshToken(req, res) {
    try {
      const raw = readRefreshCookie(req, 'console');
      if (!raw) return AuthController.refreshRefused(req, res, 'console', 'refresh_required');
      return await AuthController.rotateCookie(req, res, raw, 'console');
    } catch (error) {
      console.error('Console refresh error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /** O console só renova onde ele vale — ver `tokenMatchesHost`. */
  static consoleAllowedHere(req) {
    if (req.platformHost) return true;
    return !usesTenantSubdomains();
  }

  /**
   * O que a renovação devolve, depois de o refresh ter sido aceito: o token de
   * acesso da mesma família, conferindo de novo tudo o que a sessão exige
   * (cadastro da plataforma, vínculo com o provedor, `LOGIN_REQUIRES_EMAIL`).
   * O refresh prova presença; nunca estende autoridade.
   */
  static async accessFor(req, user, row) {
    if (!canHoldSession(user)) return null;
    if (row.audience === CONSOLE_AUDIENCE) {
      if (!AuthController.consoleAllowedHere(req) || !(await PlatformAdmin.has(user.id))) return null;
      return { token: generateConsoleTokens(user, { sessionId: row.family_id }).accessToken, platform: true };
    }
    if (row.audience !== PANEL_AUDIENCE) return null;
    // Uma sessão de painel não renova no endereço da plataforma.
    if (req.platformHost) return null;
    // O mesmo provedor em que a sessão já estava, relido da tabela: um vínculo
    // encerrado desde o login encerra a sessão na próxima renovação.
    const membership = await openMembership(user.id, row.tenant_id);
    if (!membership) return null;
    // O cookie é do host em que nasceu; num deploy com subdomínio ele não
    // viaja para outro provedor. A conferência fica pelo caso de um host
    // reaproveitado (o slug trocado de dono).
    if (!hostMatchesTenant(req, membership.tenant_id)) return null;
    await marcarAtividade(membership.tenant_id);
    return { token: generateTokens(user, membership, { sessionId: row.family_id }).accessToken, platform: false };
  }

  static async rotateCookie(req, res, raw, kind) {
    const row = await RefreshToken.findByRaw(raw);
    const audience = kind === 'console' ? CONSOLE_AUDIENCE : PANEL_AUDIENCE;
    // Um cookie do painel não renova o console, nem o contrário: a linha diz
    // de qual audiência ele é, e o nome do cookie tem que concordar.
    if (!row || row.audience !== audience) return AuthController.refreshRefused(req, res, kind);
    const user = await User.findById(row.user_id);
    if (!user) {
      await RefreshToken.revokeFamily(row.family_id);
      return AuthController.refreshRefused(req, res, kind);
    }
    const girou = await RefreshToken.rotate({ raw, row, user, context: RefreshToken.context(req) });
    if (!girou.ok) {
      if (girou.reason === 'reuse') {
        await AuthController.recordReuse(req, girou.row ?? row, user);
        return AuthController.refreshRefused(req, res, kind, 'refresh_reuse');
      }
      return AuthController.refreshRefused(req, res, kind);
    }
    const acesso = await AuthController.accessFor(req, user, girou.row ?? row);
    if (!acesso) {
      await RefreshToken.revokeFamily(row.family_id);
      return AuthController.refreshRefused(req, res, kind);
    }
    setRefreshCookie(req, res, kind, girou.raw);
    return res.json(createResponse(req.t('auth.tokenRefreshed'), {
      token: acesso.token,
      ...(acesso.platform ? { platform: true } : {})
    }));
  }

  /**
   * A transição de uma versão: o refresh JWT do frontend anterior, no corpo.
   * Conferido como sempre foi (assinatura, audiência, versão da pessoa) e
   * convertido numa família nova — ver `RefreshToken.adoptLegacy`. Na versão
   * seguinte este caminho sai, e o corpo deixa de ser aceito.
   */
  static async migrateLegacyRefresh(req, res, legacy) {
    if (typeof legacy !== 'string' || legacy.length > 4096) {
      return AuthController.refreshRefused(req, res, 'panel');
    }
    const decoded = verifyToken(legacy);
    if (!decoded || decoded.tokenType !== 'refresh') return AuthController.refreshRefused(req, res, 'panel');
    const user = await User.findById(decoded.userId);
    if (!user || Number(user.token_version || 0) !== Number(decoded.tokenVersion || 0)) {
      return AuthController.refreshRefused(req, res, 'panel');
    }
    const isConsole = decoded.aud === CONSOLE_AUDIENCE;
    if (!isConsole && decoded.aud !== PANEL_AUDIENCE) return AuthController.refreshRefused(req, res, 'panel');
    const kind = isConsole ? 'console' : 'panel';

    let tenantId = null;
    if (!isConsole) {
      // Um refresh de antes do multi-provedor não nomeia provedor: resolvido
      // pelo vínculo único, como sempre foi, ou recusado.
      const membership = await resolveMembership(user.id, decoded.tenantId);
      if (!membership) return AuthController.refreshRefused(req, res, 'panel');
      tenantId = Number(membership.tenant_id);
    }
    // A família herda o vencimento do JWT: a conversão não dá sete dias novos.
    const expiresAt = Number.isFinite(Number(decoded.exp)) ? new Date(Number(decoded.exp) * 1000) : null;
    const adotado = await RefreshToken.adoptLegacy({
      legacyToken: legacy, user, audience: isConsole ? CONSOLE_AUDIENCE : PANEL_AUDIENCE,
      tenantId, context: RefreshToken.context(req), expiresAt
    });
    if (adotado.expired) return AuthController.refreshRefused(req, res, kind);
    // Já migrado antes: a linha do JWT existe e está rotacionada. Dentro da
    // folga, a rotação devolve o mesmo sucessor; depois dela, é reuso.
    if (adotado.existing) return AuthController.rotateCookie(req, res, legacy, kind);

    const row = await RefreshToken.findByRaw(adotado.raw);
    const acesso = row ? await AuthController.accessFor(req, user, row) : null;
    if (!acesso) {
      if (row) await RefreshToken.revokeFamily(row.family_id);
      return AuthController.refreshRefused(req, res, kind);
    }
    setRefreshCookie(req, res, kind, adotado.raw);
    clearRefreshCookie(req, res, kind === 'console' ? 'panel' : 'console');
    return res.json(createResponse(req.t('auth.tokenRefreshed'), {
      token: acesso.token,
      ...(acesso.platform ? { platform: true } : {})
    }));
  }

  /**
   * As sessões abertas da pessoa — uma por aparelho (família), de todos os
   * provedores dela e do console. A personificação não lista: a conta é de
   * quem personifica, e o painel de um cliente não é lugar de mexer nela.
   */
  static async listSessions(req, res) {
    try {
      if (req.user.impersonation) {
        return res.status(403).json({
          success: false, message: req.t('auth.impersonationReadOnly'), code: 'impersonation_read_only'
        });
      }
      const linhas = await RefreshToken.listForUser(req.user.userId, req.user.tokenVersion);
      const ids = [...new Set(linhas.map((l) => l.tenant_id).filter(Boolean).map(Number))];
      const nomes = new Map();
      if (ids.length) {
        // tenant-scope-exempt: `tenants` é compartilhada; só os nomes dos
        // provedores das sessões DESTA pessoa.
        const provedores = await getDb()('tenants').whereIn('id', ids).select('id', 'name');
        for (const p of provedores) nomes.set(Number(p.id), p.name);
      }
      const atual = req.user.sessionId ?? null;
      const sessoes = linhas.map((l) => ({
        id: l.family_id,
        kind: l.audience === CONSOLE_AUDIENCE ? 'console' : 'panel',
        tenantName: l.tenant_id ? (nomes.get(Number(l.tenant_id)) ?? null) : null,
        device: describeUserAgent(l.user_agent),
        userAgent: l.user_agent ?? null,
        ip: l.ip ?? null,
        createdAt: l.family_created_at ?? l.created_at,
        lastUsedAt: l.last_used_at ?? l.created_at,
        current: atual !== null && l.family_id === atual
      }));
      sessoes.sort((a, b) => Number(b.current) - Number(a.current));
      return res.json(createResponse(null, { sessions: sessoes }));
    } catch (error) {
      console.error('List sessions error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * "Encerrar" uma sessão da lista. Só a família da PRÓPRIA pessoa: a de
   * outra, ou uma que não existe, é o mesmo 404 — o id não confirma nada.
   */
  static async revokeSession(req, res) {
    try {
      const id = String(req.params.id || '');
      const changed = await RefreshToken.revokeOwnFamily(req.user.userId, id);
      if (!changed) {
        return res.status(404).json(createErrorResponse(req.t('auth.sessionNotFound')));
      }
      const current = req.user.sessionId === id;
      if (current) {
        clearRefreshCookie(req, res, req.user.platform ? 'console' : 'panel');
      }
      return res.json(createResponse(req.t('auth.sessionRevoked'), { current }));
    } catch (error) {
      console.error('Revoke session error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
    }
  }

  /**
   * "Sair de todos": sobe o `token_version` (todo token de acesso aberto cai na
   * próxima requisição, inclusive os de antes desta versão) e revoga todas as
   * famílias. Este aparelho sai junto.
   */
  static async revokeAllSessions(req, res) {
    try {
      await User.revokeSessions(req.user.userId);
      await RefreshToken.revokeAllForUser(req.user.userId);
      clearRefreshCookie(req, res, 'panel');
      clearRefreshCookie(req, res, 'console');
      return res.json(createResponse(req.t('auth.sessionsRevokedAll')));
    } catch (error) {
      console.error('Revoke all sessions error:', error);
      return res.status(500).json(createErrorResponse(req.t('common.internalError'), error.message));
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

      const user = await User.findById(userId);
      
      if (!user) {
        return res.status(404).json(
          createErrorResponse(req.t('auth.userNotFound'))
        );
      }

      // A regra vale para a senha NOVA; a atual, conferida abaixo, é aceita
      // como estiver — inclusive a de 8 caracteres de antes desta regra.
      const senhaRuim = newPasswordProblem(
        String(newPassword),
        { username: user.username, email: user.email },
        { lengthKey: 'auth.newPasswordLength' }
      );
      if (senhaRuim) {
        return res.status(400).json(createErrorResponse(req.t(senhaRuim.key), null, senhaRuim.code));
      }

      // A senha atual pedida aqui é um oráculo nas mãos de quem tem só o
      // token — uma sessão roubada, um computador destravado — e o limitador
      // desta rota é o genérico, trezentos por minuto. Ela conta na MESMA
      // trava do login: é a mesma senha sendo adivinhada, e dez palpites por
      // aqui não podem somar a dez pelo formulário de entrada.
      const tentativa = await AccountLockout.attempt(AccountLockout.forUser(user.id));
      if (!tentativa.allowed) {
        return AccountLockout.refuse(req, res, tentativa, currentPassword, { user, via: 'change_password' });
      }
      
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      
      if (!isMatch) {
        await AccountLockout.failed(req, tentativa, { user, via: 'change_password' });
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
      // O mesmo oráculo da troca de senha, e a mesma trava.
      const tentativa = await AccountLockout.attempt(AccountLockout.forUser(user.id));
      if (!tentativa.allowed) {
        return AccountLockout.refuse(req, res, tentativa, currentPassword, { user, via: 'change_email' });
      }
      if (!await bcrypt.compare(String(currentPassword), user.password)) {
        await AccountLockout.failed(req, tentativa, { user, via: 'change_email' });
        return res.status(401).json(createErrorResponse(req.t('auth.currentPasswordIncorrect')));
      }
      await AccountLockout.clear(tentativa.subject);

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

      // Qual provedor. Com host nomeando um, é ele — a regra de sempre, e a
      // razão está no comentário acima: o link aponta para o painel dele. Sem
      // host que nomeie (deploy de host único), o provedor é o da PESSOA:
      // `req.tenantId` ali é o primeiro da tabela por fallback, e conferir
      // contra ele fazia a redefinição não existir para quem trabalha em
      // qualquer outro provedor — em silêncio, porque esta rota responde igual
      // sempre. Mesmo helper do login, para as duas regras não divergirem.
      const membership = await membershipForLogin(user.id, req.hostTenantId);
      if (!membership) return responder();
      const tenantDoPedido = Number(membership.tenant_id);

      // A trilha é do provedor e vem ANTES do envio, porque ela registra o
      // pedido e não a entrega: um SMTP que recusa não apaga o fato de alguém
      // ter pedido uma senha nova para esta conta.
      await runInTenant(tenantDoPedido, () => AuditLog.record({
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
        tenantId: tenantDoPedido,
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
      // Tamanho e lista de comuns ANTES do resgate: a recusa não pode gastar
      // o bilhete, senão quem errou a regra teria de pedir outro e-mail.
      const senhaRuim = newPasswordProblem(novaSenha, {}, { lengthKey: 'auth.newPasswordLength' });
      if (senhaRuim) {
        return res.status(400).json(createErrorResponse(req.t(senhaRuim.key), null, senhaRuim.code));
      }
      // A comparação com o login da conta também vem antes, por uma espiada
      // que não consome o bilhete. Bilhete ruim aqui só pula a checagem — o
      // resgate abaixo é quem responde por ele, com a recusa de sempre.
      const espiado = await AuthTicket.peek({
        token,
        purpose: AuthTicket.PURPOSES.PASSWORD_RESET,
        tenantId: req.hostTenantId ?? null
      });
      if (espiado) {
        const dono = await User.findById(espiado.user_id);
        const igual = newPasswordProblem(novaSenha, { username: dono?.username, email: espiado.email });
        if (igual) {
          return res.status(400).json(createErrorResponse(req.t(igual.key), null, igual.code));
        }
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
        // `hostTenantId` e não `tenantId`: o segundo é o primeiro provedor da
        // tabela onde nenhum host nomeia um, e filtrar por ele matava todo
        // bilhete cunhado para outro provedor. Nulo aqui quer dizer "não há
        // porta errada" — ver `AuthTicket.redeem`.
        tenantId: req.hostTenantId ?? null
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
        // Mesmo motivo do resgate da senha, logo acima.
        tenantId: req.hostTenantId ?? null
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
