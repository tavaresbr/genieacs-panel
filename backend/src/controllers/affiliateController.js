import bcrypt from 'bcryptjs';
import AccountLockout from '../models/AccountLockout.js';
import PlatformAudit from '../models/PlatformAudit.js';
import AffiliateService, { AffiliateError } from '../services/affiliateService.js';
import AffiliatePayoutService, { PayoutError } from '../services/affiliatePayoutService.js';
import {
  AFFILIATE_COOKIE_NAME, affiliateClearCookieOptions, affiliateCookieOptions, signAffiliateSession
} from '../middleware/affiliateAuth.js';
import { createErrorResponse, createResponse } from '../utils/helpers.js';
import { POLICY_PROBLEM_TEXT_EN } from '../utils/passwordPolicy.js';

/**
 * O programa de afiliados (0125): o portal do afiliado e o console.
 *
 * O portal (`/api/affiliate/*`) tem sessão própria (`affiliateAuth.js`) e
 * nenhum parâmetro de caminho: tudo o que ele lê sai do id da sessão. O
 * console (`/api/platform/affiliates*` e `/affiliate-payouts*`) é do plano de
 * controle, e cada gesto vai para a trilha da plataforma.
 */

/** O hash de enfeite para o login de e-mail que não existe: o tempo não conta nada. */
const DUMMY_HASH = bcrypt.hashSync('skygenpanel-affiliate-placeholder', 12);

function falha(res, error, contexto) {
  if (error instanceof AffiliateError || error instanceof PayoutError) {
    return res.status(error.status).json({
      ...createErrorResponse(error.message, null, error.code),
      ...(error.field ? { field: error.field } : {})
    });
  }
  if (error?.name === 'AsaasError') {
    return res.status(502).json(createErrorResponse('The payment gateway refused or did not answer', null, 'gateway_error'));
  }
  console.error(`${contexto}:`, error);
  return res.status(500).json(createErrorResponse(`${contexto} failed`, null, 'internal_error'));
}

const auditar = (req, action, detail) => PlatformAudit.fromRequest(req, { action, detail });

class AffiliateController {
  // ── O portal ────────────────────────────────────────────────────────

  /** `POST /api/affiliate/login` — `{ email, password }`. */
  static async login(req, res) {
    try {
      const email = String(req.body?.email ?? '').trim().toLowerCase().slice(0, 160);
      const senha = String(req.body?.password ?? '');
      const invalido = () => res.status(401).json(createErrorResponse(req.t('affiliate.invalidCredentials'), null, 'invalid_credentials'));
      if (!email || !senha || senha.length > 128) return invalido();
      const afiliado = await AffiliateService.findByEmail(email);
      // A trava por conta, a mesma do login do painel, com sujeitos do afiliado.
      const sujeito = afiliado ? `affiliate:${afiliado.id}` : AccountLockout.forIdentifier(`affiliate:${email}`);
      const tentativa = await AccountLockout.attempt(sujeito);
      if (!tentativa.allowed) return AccountLockout.refuse(req, res, tentativa, senha, { via: 'affiliate_login' });
      const ok = await bcrypt.compare(senha, afiliado?.password_hash || DUMMY_HASH);
      if (!afiliado || !afiliado.password_hash || !ok || afiliado.status !== 'active') {
        await AccountLockout.failed(req, tentativa, { via: 'affiliate_login' });
        return invalido();
      }
      await AccountLockout.clear(tentativa.subject);
      res.cookie(AFFILIATE_COOKIE_NAME, signAffiliateSession(afiliado), affiliateCookieOptions(req));
      return res.json(createResponse(req.t('affiliate.loginSuccess'), { name: afiliado.name }, 'login_ok'));
    } catch (error) {
      return falha(res, error, 'Affiliate login');
    }
  }

  /**
   * `POST /api/affiliate/password` — `{ token, password }`: o link do console
   * (definir ou redefinir a senha). O token vai no corpo, nunca no caminho.
   * Toda recusa do token é o mesmo 400. Definida, a sessão já começa.
   */
  static async setPassword(req, res) {
    try {
      const resultado = await AffiliateService.setPasswordWithToken(req.body?.token, req.body?.password);
      if (resultado.error === 'weak_password') {
        // O código do que falhou na política (`password_length`,
        // `password_too_common`, `password_matches_identity`) vai junto, em
        // `problem`, para a tela dizer o porquê.
        const texto = POLICY_PROBLEM_TEXT_EN[resultado.problem] ?? 'The password must have 10 to 128 characters';
        return res.status(400).json({ ...createErrorResponse(texto, null, 'weak_password'), problem: resultado.problem ?? null });
      }
      if (resultado.error) return res.status(400).json(createErrorResponse('This link is no longer valid', null, 'invalid_token'));
      await AccountLockout.clear(`affiliate:${resultado.affiliate.id}`);
      if (resultado.affiliate.status === 'active') {
        res.cookie(AFFILIATE_COOKIE_NAME, signAffiliateSession(resultado.affiliate), affiliateCookieOptions(req));
      }
      return res.json(createResponse('Password set', { active: resultado.affiliate.status === 'active' }, 'password_set'));
    } catch (error) {
      return falha(res, error, 'Affiliate password');
    }
  }

  static async logout(req, res) {
    res.clearCookie(AFFILIATE_COOKIE_NAME, affiliateClearCookieOptions(req));
    return res.json(createResponse('Logged out', null, 'logout_ok'));
  }

  /** `GET /api/affiliate/overview` — o painel do afiliado da sessão. */
  static async overview(req, res) {
    try {
      const dados = await AffiliateService.portalOverview(req.affiliate.id);
      if (!dados) return res.status(401).json(createErrorResponse('Session expired', null, 'affiliate_session_invalid'));
      return res.json(createResponse('Affiliate overview', dados));
    } catch (error) {
      return falha(res, error, 'Affiliate overview');
    }
  }

  // ── O console: afiliados ─────────────────────────────────────────────

  static async list(req, res) {
    try {
      return res.json(createResponse('Affiliates retrieved', await AffiliateService.listForConsole()));
    } catch (error) {
      return falha(res, error, 'Affiliate list');
    }
  }

  static async detail(req, res) {
    try {
      const dados = await AffiliateService.detailForConsole(req.params.id);
      if (!dados) return res.status(404).json(createErrorResponse('Affiliate not found', null, 'not_found'));
      return res.json(createResponse('Affiliate retrieved', dados));
    } catch (error) {
      return falha(res, error, 'Affiliate detail');
    }
  }

  static async create(req, res) {
    try {
      const afiliado = await AffiliateService.create(req.body ?? {}, { actorUserId: req.user?.userId ?? null });
      await auditar(req, PlatformAudit.ACTIONS.AFFILIATE_CREATED, {
        affiliateId: Number(afiliado.id), code: afiliado.code, status: afiliado.status
      });
      return res.status(201).json(createResponse('Affiliate created', { affiliate: AffiliateService.present(afiliado) }));
    } catch (error) {
      return falha(res, error, 'Affiliate create');
    }
  }

  /**
   * `PATCH /api/platform/affiliates/:id` — os dados e, com `status`, a
   * aprovação (`active`) ou a suspensão (`suspended`). Cada um com a sua
   * linha na trilha: o detalhe nomeia os CAMPOS que mudaram, nunca a chave Pix.
   */
  static async update(req, res) {
    try {
      const body = req.body ?? {};
      const { status, ...dados } = body;
      let atual = await AffiliateService.findById(req.params.id);
      if (!atual) return res.status(404).json(createErrorResponse('Affiliate not found', null, 'not_found'));
      const { affiliate, changed } = await AffiliateService.update(atual.id, dados);
      atual = affiliate;
      if (changed.length) {
        await auditar(req, PlatformAudit.ACTIONS.AFFILIATE_UPDATED, { affiliateId: Number(atual.id), fields: changed });
      }
      if (status !== undefined && status !== atual.status) {
        const resultado = await AffiliateService.setStatus(atual.id, status, { actorUserId: req.user?.userId ?? null });
        if (resultado.changed) {
          await auditar(req, PlatformAudit.ACTIONS.AFFILIATE_STATUS_CHANGED, {
            affiliateId: Number(atual.id), from: resultado.from, to: status
          });
        }
        atual = resultado.affiliate;
      }
      return res.json(createResponse('Affiliate updated', { affiliate: AffiliateService.present(atual) }));
    } catch (error) {
      return falha(res, error, 'Affiliate update');
    }
  }

  /** `POST /api/platform/affiliates/:id/password-link` — o token cru UMA vez. */
  static async passwordLink(req, res) {
    try {
      const { token, expiresAt } = await AffiliateService.issuePasswordLink(req.params.id);
      await auditar(req, PlatformAudit.ACTIONS.AFFILIATE_PASSWORD_LINK, { affiliateId: Number(req.params.id) });
      return res.json(createResponse('Password link issued', { token, expiresAt: expiresAt.toISOString(), path: `/afiliados#senha=${token}` }));
    } catch (error) {
      return falha(res, error, 'Affiliate password link');
    }
  }

  // ── O console: lotes ─────────────────────────────────────────────────

  static async listPayouts(req, res) {
    try {
      const period = /^\d{4}-\d{2}$/.test(String(req.query?.period ?? '')) ? String(req.query.period) : null;
      const status = typeof req.query?.status === 'string' && /^[a-z]{3,16}$/.test(req.query.status) ? req.query.status : null;
      const linhas = await AffiliatePayoutService.list({ period, status });
      return res.json(createResponse('Payouts retrieved', { payouts: linhas.map((l) => AffiliatePayoutService.present(l)) }));
    } catch (error) {
      return falha(res, error, 'Affiliate payout list');
    }
  }

  /** `POST /api/platform/affiliate-payouts/build` — `{ period? }`: monta, nunca aprova. */
  static async buildPayouts(req, res) {
    try {
      const bruto = req.body?.period;
      const period = bruto === undefined || bruto === null || bruto === '' ? null : String(bruto);
      const resultado = await AffiliatePayoutService.buildBatches({ period });
      await auditar(req, PlatformAudit.ACTIONS.AFFILIATE_PAYOUTS_BUILT, {
        period: resultado.period, created: resultado.created.length, carried: resultado.carried.length
      });
      return res.json(createResponse('Payouts built', resultado));
    } catch (error) {
      return falha(res, error, 'Affiliate payout build');
    }
  }

  /** As ações de um lote, com a mesma forma: a ação, a trilha e o lote depois. */
  static acaoDoLote(nome, acao, executar) {
    return async (req, res) => {
      try {
        const antes = await AffiliatePayoutService.findById(req.params.id);
        if (!antes) return res.status(404).json(createErrorResponse('Payout not found', null, 'not_found'));
        const depois = await executar(req, antes);
        const falhou = nome === 'send' && depois.status === 'failed';
        await auditar(req, falhou ? PlatformAudit.ACTIONS.AFFILIATE_PAYOUT_SEND_FAILED : acao, {
          payoutId: Number(depois.id),
          affiliateId: Number(depois.affiliate_id),
          period: depois.period,
          amountCents: Number(depois.amount_cents),
          from: antes.status,
          to: depois.status,
          ...(depois.transfer_id ? { transferId: depois.transfer_id } : {}),
          ...(falhou ? { errorCode: depois.error_code } : {})
        });
        return res.json(createResponse(`Payout ${nome}`, { payout: AffiliatePayoutService.present(depois) }));
      } catch (error) {
        return falha(res, error, `Affiliate payout ${nome}`);
      }
    };
  }

  static approvePayout = AffiliateController.acaoDoLote('approve', PlatformAudit.ACTIONS.AFFILIATE_PAYOUT_APPROVED,
    (req, lote) => AffiliatePayoutService.approve(lote.id, { actorUserId: req.user?.userId ?? null }));

  static sendPayout = AffiliateController.acaoDoLote('send', PlatformAudit.ACTIONS.AFFILIATE_PAYOUT_SENT,
    (req, lote) => AffiliatePayoutService.send(lote.id, { confirmNotSent: req.body?.confirmNotSent === true }));

  static refreshPayout = AffiliateController.acaoDoLote('refresh', PlatformAudit.ACTIONS.AFFILIATE_PAYOUT_REFRESHED,
    (req, lote) => AffiliatePayoutService.refresh(lote.id));

  static markPayoutPaid = AffiliateController.acaoDoLote('paid', PlatformAudit.ACTIONS.AFFILIATE_PAYOUT_PAID,
    (req, lote) => AffiliatePayoutService.markPaid(lote.id, { note: req.body?.note ? String(req.body.note) : null }));

  static cancelPayout = AffiliateController.acaoDoLote('cancel', PlatformAudit.ACTIONS.AFFILIATE_PAYOUT_CANCELED,
    (req, lote) => AffiliatePayoutService.cancel(lote.id, { confirmNotSent: req.body?.confirmNotSent === true }));
}

export default AffiliateController;
