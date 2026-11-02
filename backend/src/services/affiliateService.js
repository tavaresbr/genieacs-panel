import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { getDb, insertReturningId, isUniqueViolation } from '../config/database.js';
import { affiliateConfig } from './platformProfileService.js';
import { maskName } from './referralService.js';
import { panelBaseDomain, platformExtraHosts } from '../middleware/tenantResolver.js';
import { isValidEmail } from '../utils/helpers.js';
import { isValidCnpj, isValidCpf, normalizeTaxId } from '../utils/taxId.js';
import { PIX_KEY_TYPES } from './billing/asaasClient.js';
import { newPasswordProblem } from '../utils/passwordPolicy.js';

/**
 * O programa de afiliados (0126): quem divulga o produto sem ser provedor.
 *
 * O afiliado tem um código (`A-XXXXXXX`) e um link `…/signup?aff=CÓDIGO`. O
 * provedor que se cadastra por esse link nasce com `referred_by_affiliate_id`
 * e `referred_at`. A partir daí, CADA pagamento dele — dentro da janela de
 * meses do afiliado (padrão 12, contados de `referred_at`) — gera uma
 * comissão de `rate_bp` (padrão 10%) sobre o que entrou, gravada NA MESMA
 * TRANSAÇÃO do evento do pagamento (`SubscriptionService.recordPayment`):
 *
 *   - a reentrega do webhook morre no índice único do evento, e a comissão
 *     volta junto no rollback;
 *   - e a própria comissão tem `payment_ref` único, num savepoint: a corrida
 *     que passasse do evento ainda bateria aqui, sem derrubar o pagamento.
 *
 * O estorno do pagamento (`reversePayment`) desfaz a comissão na transação
 * do estorno: a que ainda não foi para lote vira `reversed`; a que está num
 * lote em rascunho sai dele; a que já está num lote aprovado ou pago vira um
 * `clawback` negativo, abatido do próximo lote. Nunca se mexe num valor que
 * alguém já aprovou.
 *
 * O dinheiro sai em `AffiliatePayoutService`, e só com aprovação manual.
 *
 * Tabelas compartilhadas (`SHARED_TABLES`): toda leitura nomeia o afiliado ou
 * o provedor de que fala.
 */

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TAMANHO_DO_CODIGO = 7;
export const AFFILIATE_STATUSES = Object.freeze(['pending', 'active', 'suspended']);
// `held` (0126): a comissão de um afiliado SUSPENSO — fica guardada e volta a
// `accrued` quando ele é reativado ainda dentro da janela da indicação.
export const COMMISSION_STATUSES = Object.freeze(['accrued', 'reversed', 'in_payout', 'paid', 'held']);
/** Quanto vale o link de definir senha. */
export const PASSWORD_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;
const BCRYPT_ROUNDS = 12;

export class AffiliateError extends Error {
  constructor(message, { code = 'invalid', field = null, status = 400 } = {}) {
    super(message);
    this.name = 'AffiliateError';
    this.code = code;
    this.field = field;
    this.status = status;
  }
}

/** Um código novo, aleatório, com o prefixo que o separa do código dos provedores. */
export function generateAffiliateCode() {
  // `randomInt` e não `byte % 31`: o resto de 256 por 31 favorece as
  // primeiras letras do alfabeto; `randomInt` sorteia sem esse viés.
  let codigo = 'A-';
  for (let i = 0; i < TAMANHO_DO_CODIGO; i += 1) codigo += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return codigo;
}

/**
 * O código como veio do link (`?aff=`): maiúsculas, e sempre com o prefixo
 * `A-` — que é o que o separa do `?ref=` dos provedores. Nulo quando não serve.
 */
export function normalizeAffiliateCode(bruto) {
  const texto = String(bruto ?? '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
  const corpo = texto.startsWith('A-') ? texto.slice(2) : texto.replace(/-/g, '');
  if (!/^[A-Z0-9]{3,13}$/.test(corpo)) return null;
  return `A-${corpo}`;
}

/** O endereço do cadastro com o código — ou nulo, quando o deploy não sabe o próprio. */
export function affiliateSignupUrl(code) {
  if (!code) return null;
  const host = panelBaseDomain() || platformExtraHosts()[0] || null;
  if (!host) return null;
  return `https://${host}/signup?aff=${encodeURIComponent(code)}`;
}

/** Uma data do banco (Date, número do SQLite, texto) como Date — ou nulo. */
export function asDate(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const data = valor instanceof Date ? valor : new Date(typeof valor === 'number' ? valor : String(valor));
  return Number.isNaN(data.getTime()) ? null : data;
}

/**
 * `meses` meses depois de `data`, no calendário (UTC): 31/01 + 1 mês é 28 ou
 * 29/02, e não 03/03 — a janela não ganha dias de brinde no fim do mês.
 */
export function addMonths(data, meses) {
  const ano = data.getUTCFullYear();
  const mes = data.getUTCMonth() + meses;
  const alvo = new Date(Date.UTC(ano, mes, 1));
  const ultimoDia = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    alvo.getUTCFullYear(), alvo.getUTCMonth(), Math.min(data.getUTCDate(), ultimoDia),
    data.getUTCHours(), data.getUTCMinutes(), data.getUTCSeconds(), data.getUTCMilliseconds()
  ));
}

/** A comissão de um pagamento: piso, em centavos. */
export function commissionCents(baseCents, rateBp) {
  const base = Number(baseCents);
  const taxa = Number(rateBp);
  if (!Number.isInteger(base) || base <= 0 || !Number.isInteger(taxa) || taxa <= 0) return 0;
  return Math.floor((base * taxa) / 10000);
}

/**
 * A chave Pix conferida e normalizada para o tipo dela, ou o erro. Telefone
 * fica só com dígitos (DDD + número, sem o 55); CPF e CNPJ, com dígitos e o
 * verificador conferido; a aleatória (EVP), em minúsculas.
 */
export function normalizePixKey(tipoBruto, chaveBruta) {
  const tipo = String(tipoBruto ?? '').trim().toUpperCase();
  const chave = String(chaveBruta ?? '').trim();
  if (!PIX_KEY_TYPES.includes(tipo)) throw new AffiliateError('pixKeyType is invalid', { code: 'invalid_pix_key_type', field: 'pixKeyType' });
  const recusa = () => new AffiliateError('pixKey does not match its type', { code: 'invalid_pix_key', field: 'pixKey' });
  if (tipo === 'CPF') {
    const d = normalizeTaxId(chave);
    if (!isValidCpf(d)) throw recusa();
    return { type: tipo, key: d };
  }
  if (tipo === 'CNPJ') {
    const d = normalizeTaxId(chave);
    if (!isValidCnpj(d)) throw recusa();
    return { type: tipo, key: d };
  }
  if (tipo === 'EMAIL') {
    const email = chave.toLowerCase();
    if (email.length > 77 || !isValidEmail(email)) throw recusa();
    return { type: tipo, key: email };
  }
  if (tipo === 'PHONE') {
    let d = chave.replace(/\D/g, '');
    if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
    if (d.length < 10 || d.length > 11) throw recusa();
    return { type: tipo, key: d };
  }
  const evp = chave.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(evp)) throw recusa();
  return { type: tipo, key: evp };
}

/** A chave Pix como o portal a mostra: o bastante para reconhecer, não para copiar. */
export function maskPixKey(chave) {
  const texto = String(chave ?? '');
  if (!texto) return null;
  if (texto.length <= 4) return '•••';
  return `${'•'.repeat(Math.min(8, texto.length - 4))}${texto.slice(-4)}`;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function inteiroOuNulo(bruto, { min, max, campo }) {
  if (bruto === null || bruto === undefined || bruto === '') return null;
  const numero = typeof bruto === 'number' ? bruto : Number(String(bruto).trim());
  if (!Number.isInteger(numero) || numero < min || numero > max) {
    throw new AffiliateError(`${campo} must be an integer from ${min} to ${max}`, { code: `invalid_${campo}`, field: campo });
  }
  return numero;
}

const tabela = () => getDb()('affiliates');

class AffiliateService {
  static async findById(id, trx = null) {
    const numero = Number(id);
    if (!Number.isInteger(numero) || numero <= 0) return null;
    return (await (trx || getDb())('affiliates').where({ id: numero }).first()) || null;
  }

  static async findByEmail(email) {
    const texto = String(email ?? '').trim().toLowerCase();
    if (!texto) return null;
    return (await tabela().where({ email: texto }).first()) || null;
  }

  static async findByCode(code, trx = null) {
    const normalizado = normalizeAffiliateCode(code);
    if (!normalizado) return null;
    return (await (trx || getDb())('affiliates').where({ code: normalizado }).first()) || null;
  }

  /**
   * Os campos do formulário do console, conferidos. `parcial` é a edição:
   * ausente mantém. Devolve só as colunas a gravar.
   */
  static validate(body = {}, { parcial = false } = {}) {
    const linha = {};
    const tem = (campo) => Object.prototype.hasOwnProperty.call(body, campo) && body[campo] !== undefined;
    if (!parcial || tem('name')) {
      const nome = String(body.name ?? '').trim();
      if (nome.length < 2 || nome.length > 160) throw new AffiliateError('name is required (2-160 characters)', { code: 'invalid_name', field: 'name' });
      linha.name = nome;
    }
    if (!parcial || tem('email')) {
      const email = String(body.email ?? '').trim().toLowerCase();
      if (!email || email.length > 160 || !isValidEmail(email)) throw new AffiliateError('email is invalid', { code: 'invalid_email', field: 'email' });
      linha.email = email;
    }
    if (tem('taxId')) {
      const doc = normalizeTaxId(body.taxId);
      if (doc && !isValidCpf(doc) && !isValidCnpj(doc)) throw new AffiliateError('taxId is not a valid CPF or CNPJ', { code: 'invalid_tax_id', field: 'taxId' });
      linha.tax_id = doc || null;
    }
    if (tem('pixKey') || tem('pixKeyType')) {
      const chave = String(body.pixKey ?? '').trim();
      if (!chave) {
        linha.pix_key = null;
        linha.pix_key_type = null;
      } else {
        const pix = normalizePixKey(body.pixKeyType, chave);
        linha.pix_key = pix.key;
        linha.pix_key_type = pix.type;
      }
    }
    if (tem('rateBp')) linha.rate_bp = inteiroOuNulo(body.rateBp, { min: 0, max: 10000, campo: 'rateBp' });
    if (tem('months')) linha.months = inteiroOuNulo(body.months, { min: 1, max: 120, campo: 'months' });
    if (tem('notes')) {
      const notas = String(body.notes ?? '').trim();
      linha.notes = notas ? notas.slice(0, 500) : null;
    }
    if (tem('code')) {
      const texto = String(body.code ?? '').trim();
      if (texto) {
        const codigo = normalizeAffiliateCode(texto);
        if (!codigo) throw new AffiliateError('code must be A- followed by 3 to 13 letters or digits', { code: 'invalid_code', field: 'code' });
        linha.code = codigo;
      }
    }
    return linha;
  }

  /**
   * Cadastra. Nasce `pending` (ou `active`, quando o console já aprova na
   * criação), sem senha: quem a define é o próprio afiliado, pelo link
   * (`issuePasswordLink`). E-mail e código repetidos são 409.
   */
  static async create(body = {}, { actorUserId = null, now = new Date() } = {}) {
    const linha = AffiliateService.validate(body);
    const ativo = body.status === 'active';
    for (let tentativa = 0; tentativa < 5; tentativa += 1) {
      const codigo = linha.code ?? generateAffiliateCode();
      try {
        // eslint-disable-next-line no-await-in-loop -- só repete na colisão do código gerado
        const id = await insertReturningId('affiliates', {
          ...linha,
          code: codigo,
          status: ativo ? 'active' : 'pending',
          approved_by: ativo ? actorUserId : null,
          approved_at: ativo ? now : null,
          created_at: now,
          updated_at: now
        });
        // eslint-disable-next-line no-await-in-loop
        return AffiliateService.findById(id);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // eslint-disable-next-line no-await-in-loop
        if (await AffiliateService.findByEmail(linha.email)) {
          throw new AffiliateError('An affiliate with this email already exists', { code: 'email_taken', field: 'email', status: 409 });
        }
        if (linha.code) throw new AffiliateError('This code is already in use', { code: 'code_taken', field: 'code', status: 409 });
      }
    }
    throw new AffiliateError('Could not generate a free code; try again', { code: 'code_taken', status: 409 });
  }

  /** Edita os dados. Devolve `{ affiliate, changed }` — os NOMES dos campos que mudaram. */
  static async update(id, body = {}, { now = new Date() } = {}) {
    const antes = await AffiliateService.findById(id);
    if (!antes) throw new AffiliateError('Affiliate not found', { code: 'not_found', status: 404 });
    const linha = AffiliateService.validate(body, { parcial: true });
    const changed = Object.keys(linha).filter((coluna) => String(linha[coluna] ?? '') !== String(antes[coluna] ?? ''));
    if (!changed.length) return { affiliate: antes, changed: [] };
    const patch = Object.fromEntries(changed.map((coluna) => [coluna, linha[coluna]]));
    // Trocar o e-mail encerra a sessão e o link de senha abertos: a senha é
    // da pessoa daquele endereço.
    if (patch.email) {
      patch.password_token_hash = null;
      patch.password_token_expires_at = null;
    }
    try {
      await tabela().where({ id: antes.id }).update({ ...patch, updated_at: now });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      if (patch.email) throw new AffiliateError('An affiliate with this email already exists', { code: 'email_taken', field: 'email', status: 409 });
      throw new AffiliateError('This code is already in use', { code: 'code_taken', field: 'code', status: 409 });
    }
    return { affiliate: await AffiliateService.findById(antes.id), changed };
  }

  /** Aprova, suspende ou reativa. Condicional: devolve nulo se nada mudou. */
  static async setStatus(id, status, { actorUserId = null, now = new Date() } = {}) {
    if (!AFFILIATE_STATUSES.includes(status) || status === 'pending') {
      throw new AffiliateError('status must be active or suspended', { code: 'invalid_status', field: 'status' });
    }
    const antes = await AffiliateService.findById(id);
    if (!antes) throw new AffiliateError('Affiliate not found', { code: 'not_found', status: 404 });
    if (antes.status === status) return { affiliate: antes, from: antes.status, changed: false };
    const patch = { status, updated_at: now };
    if (status === 'active' && !antes.approved_at) {
      patch.approved_at = now;
      patch.approved_by = actorUserId;
    }
    await tabela().where({ id: antes.id, status: antes.status }).update(patch);
    const depois = await AffiliateService.findById(antes.id);
    const changed = depois.status === status;
    const released = changed && status === 'active' ? await AffiliateService.releaseHeld(depois, { now }) : null;
    return { affiliate: depois, from: antes.status, changed, ...(released ? { released } : {}) };
  }

  /**
   * As comissões guardadas (`held`) enquanto o afiliado esteve suspenso, na
   * reativação: a de um indicado cuja janela ainda corre volta a `accrued`
   * (com a data de origem, e entra no próximo lote); a de janela já vencida
   * é perdida (`reversed`) — a suspensão adia, não estica a janela.
   *
   * @returns {Promise<{ released: number, forfeited: number }>}
   */
  static async releaseHeld(afiliado, { now = new Date() } = {}) {
    const guardadas = await getDb()('affiliate_commissions')
      .where({ affiliate_id: afiliado.id, status: 'held' }).select('id', 'tenant_id');
    if (!guardadas.length) return { released: 0, forfeited: 0 };
    const config = await affiliateConfig();
    const meses = afiliado.months ?? config.months;
    const ids = [...new Set(guardadas.map((l) => Number(l.tenant_id)))];
    const tenants = new Map((await getDb()('tenants').whereIn('id', ids).select('id', 'referred_at', 'created_at'))
      .map((t) => [Number(t.id), t]));
    const liberar = [];
    const perder = [];
    for (const linha of guardadas) {
      const t = tenants.get(Number(linha.tenant_id));
      const inicio = asDate(t?.referred_at) ?? asDate(t?.created_at);
      const dentro = inicio && now.getTime() < addMonths(inicio, meses).getTime();
      (dentro ? liberar : perder).push(linha.id);
    }
    const released = liberar.length
      ? await getDb()('affiliate_commissions').whereIn('id', liberar).where({ status: 'held' }).update({ status: 'accrued' })
      : 0;
    const forfeited = perder.length
      ? await getDb()('affiliate_commissions').whereIn('id', perder).where({ status: 'held' })
        .update({ status: 'reversed', reversed_at: now })
      : 0;
    return { released: Number(released) || 0, forfeited: Number(forfeited) || 0 };
  }

  /**
   * O link de definir (ou redefinir) a senha: um token de 32 bytes, guardado
   * só como sha256, válido por sete dias, de uso único. Cunhar outro invalida
   * o anterior — é a mesma coluna.
   */
  static async issuePasswordLink(id, { now = new Date() } = {}) {
    const antes = await AffiliateService.findById(id);
    if (!antes) throw new AffiliateError('Affiliate not found', { code: 'not_found', status: 404 });
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Math.floor((now.getTime() + PASSWORD_LINK_TTL_MS) / 1000) * 1000);
    await tabela().where({ id: antes.id }).update({
      password_token_hash: hashToken(token),
      password_token_expires_at: expiresAt,
      updated_at: now
    });
    return { token, expiresAt };
  }

  /**
   * O afiliado define a senha pelo link. O token é gasto por atualização
   * condicional sobre o próprio hash: dois envios do mesmo link, um só grava.
   * Suspenso não define nada. Devolve o afiliado, ou nulo para toda recusa.
   */
  static async setPasswordWithToken(token, senha, { now = new Date() } = {}) {
    const texto = String(token ?? '').trim();
    if (!/^[0-9a-f]{64}$/.test(texto)) return { error: 'invalid_token' };
    const nova = String(senha ?? '');
    if (nova.length < PASSWORD_MIN || nova.length > PASSWORD_MAX) return { error: 'weak_password', problem: 'password_length' };
    const hash = hashToken(texto);
    const linha = await tabela().where({ password_token_hash: hash }).first();
    const vence = asDate(linha?.password_token_expires_at);
    if (!linha || !vence || vence.getTime() <= now.getTime() || linha.status === 'suspended') return { error: 'invalid_token' };
    // A política de senha do produto inteiro: a comum demais e a igual ao
    // e-mail (ou à parte antes do @) são recusadas, como no convite.
    const problema = newPasswordProblem(nova, { email: linha.email });
    if (problema) return { error: 'weak_password', problem: problema.code };
    const passwordHash = await bcrypt.hash(nova, BCRYPT_ROUNDS);
    const mudou = await tabela().where({ id: linha.id, password_token_hash: hash }).update({
      password_hash: passwordHash,
      password_set_at: now,
      password_token_hash: null,
      password_token_expires_at: null,
      updated_at: now
    });
    if (!mudou) return { error: 'invalid_token' };
    return { affiliate: await AffiliateService.findById(linha.id) };
  }

  /**
   * Liga o provedor recém-cadastrado ao afiliado do link, na transação do
   * cadastro. Código inválido, afiliado que não está `active`, ou o afiliado
   * se cadastrando a si mesmo (o mesmo e-mail ou o mesmo CPF/CNPJ) é ignorado
   * em silêncio. Devolve o id do afiliado, ou nulo.
   */
  static async attachAtSignup({
    trx, tenantId, code, email = null, taxId = null, now = new Date()
  }) {
    if (!code) return null;
    const afiliado = await AffiliateService.findByCode(code, trx);
    if (!afiliado || afiliado.status !== 'active') return null;
    if (email && String(afiliado.email).toLowerCase() === String(email).toLowerCase()) return null;
    if (taxId && afiliado.tax_id && normalizeTaxId(taxId) === String(afiliado.tax_id)) return null;
    const quando = new Date(Math.floor(now.getTime() / 1000) * 1000);
    await trx('tenants').where({ id: tenantId }).whereNull('referred_by_affiliate_id')
      .update({ referred_by_affiliate_id: afiliado.id, referred_at: quando });
    return Number(afiliado.id);
  }

  /**
   * O que o pagamento do indicado precisa saber ANTES da transação — de quem
   * é a comissão, a taxa e se a janela ainda vale —, lido fora dela pelo
   * motivo de `ReferralService.prepareReward` (no SQLite a transação segura a
   * única conexão). Nulo quando não há comissão a gravar.
   */
  static async prepareCommission(tenantId, { now = new Date() } = {}) {
    const db = getDb();
    const tenant = await db('tenants').where({ id: tenantId })
      .first('referred_by_affiliate_id', 'referred_at', 'created_at', 'kind');
    const affiliateId = Number(tenant?.referred_by_affiliate_id ?? 0);
    if (!affiliateId || tenant.kind === 'platform') return null;
    const afiliado = await AffiliateService.findById(affiliateId);
    // O suspenso não perde a comissão: ela nasce `held` e só entra num lote
    // quando ele for reativado dentro da janela (`releaseHeld`). O pendente
    // (nunca aprovado) não tem comissão nenhuma.
    if (!afiliado || !['active', 'suspended'].includes(afiliado.status)) return null;
    const config = await affiliateConfig();
    const rateBp = afiliado.rate_bp ?? config.rateBp;
    const months = afiliado.months ?? config.months;
    if (!Number.isInteger(rateBp) || rateBp <= 0) return null;
    const inicio = asDate(tenant.referred_at) ?? asDate(tenant.created_at);
    if (!inicio) return null;
    const fim = addMonths(inicio, months);
    if (now.getTime() >= fim.getTime()) return null;
    return {
      affiliateId, rateBp, months, windowEndsAt: fim.toISOString(), held: afiliado.status === 'suspended'
    };
  }

  /**
   * A comissão, NA TRANSAÇÃO do pagamento. Num savepoint: a colisão do
   * índice único de `payment_ref` (a mesma referência de novo) não pode
   * derrubar a transação do pagamento — no Postgres, um erro dentro dela a
   * invalida inteira. Devolve o que entra no detalhe do evento, ou nulo.
   */
  static async accrueOnPayment({
    trx, tenantId, prepared, paymentRef, baseCents, now = new Date()
  }) {
    if (!prepared || !paymentRef) return null;
    const valor = commissionCents(baseCents, prepared.rateBp);
    if (valor <= 0) return null;
    let id = null;
    try {
      id = await trx.transaction((sp) => insertReturningId('affiliate_commissions', {
        affiliate_id: prepared.affiliateId,
        tenant_id: tenantId,
        payment_ref: String(paymentRef).slice(0, 160),
        kind: 'commission',
        base_cents: Number(baseCents),
        rate_bp: prepared.rateBp,
        amount_cents: valor,
        status: prepared.held ? 'held' : 'accrued',
        accrued_at: now,
        created_at: now
      }, sp));
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
    return {
      affiliateCommission: {
        id: Number(id), affiliateId: prepared.affiliateId, amountCents: valor, rateBp: prepared.rateBp,
        ...(prepared.held ? { held: true } : {})
      }
    };
  }

  /**
   * O estorno do pagamento que gerou a comissão, NA TRANSAÇÃO do estorno
   * (que é única pelo evento `<referência>:refund`):
   *
   *   - `accrued`: vira `reversed`;
   *   - num lote em RASCUNHO: sai do lote (que é recalculado) e vira `reversed`;
   *   - num lote já aprovado, enviado ou pago: um `clawback` negativo, que o
   *     próximo lote abate. O lote aprovado não muda de valor por baixo de
   *     quem o aprovou.
   *
   * @returns {Promise<object|null>} o que entra no detalhe do evento do estorno.
   */
  static async reverseOnRefund({
    trx, tenantId, reference, now = new Date()
  }) {
    const referencia = String(reference ?? '').trim().slice(0, 160);
    if (!referencia) return null;
    const comissao = await trx('affiliate_commissions')
      .where({ payment_ref: referencia, tenant_id: tenantId, kind: 'commission' })
      .first();
    if (!comissao || comissao.status === 'reversed') return null;
    const resumo = (modo) => ({
      affiliateCommissionReversed: {
        id: Number(comissao.id), affiliateId: Number(comissao.affiliate_id), amountCents: Number(comissao.amount_cents), mode: modo
      }
    });
    if (comissao.status === 'accrued' || comissao.status === 'held') {
      const mudou = await trx('affiliate_commissions').where({ id: comissao.id, status: comissao.status })
        .update({ status: 'reversed', reversed_at: now });
      if (mudou) return resumo('reversed');
    }
    const atual = await trx('affiliate_commissions').where({ id: comissao.id }).first();
    if (atual.status === 'in_payout' && atual.payout_id) {
      // O lote em rascunho perde o valor PRIMEIRO, por atualização condicional
      // sobre `draft`: se a aprovação ganhou a corrida, nada muda nele e a
      // comissão vira abatimento no próximo lote (abaixo). Só com o lote já
      // diminuído a comissão sai dele — a aprovação, que recalcula o total
      // pelas comissões dentro da própria trava, não vê os dois pela metade.
      const valor = Number(atual.amount_cents);
      const baixou = await trx('affiliate_payouts').where({ id: atual.payout_id, status: 'draft' }).update({
        amount_cents: trx.raw('amount_cents - ?', [valor]),
        commission_count: trx.raw('CASE WHEN commission_count > 0 THEN commission_count - 1 ELSE 0 END'),
        updated_at: now
      });
      if (baixou) {
        const saiu = await trx('affiliate_commissions')
          .where({ id: atual.id, status: 'in_payout', payout_id: atual.payout_id })
          .update({ status: 'reversed', reversed_at: now, payout_id: null });
        if (saiu) return resumo('removed_from_draft');
        // A comissão mudou no meio (não deveria, com o lote em rascunho):
        // devolve o valor ao lote e segue para o abatimento.
        await trx('affiliate_payouts').where({ id: atual.payout_id }).update({
          amount_cents: trx.raw('amount_cents + ?', [valor]),
          commission_count: trx.raw('commission_count + 1'),
          updated_at: now
        });
      }
    }
    if (atual.status === 'reversed') return null;
    // Já aprovada, enviada ou paga: o abatimento no próximo lote.
    try {
      const id = await trx.transaction((sp) => insertReturningId('affiliate_commissions', {
        affiliate_id: atual.affiliate_id,
        tenant_id: tenantId,
        payment_ref: `${referencia}:refund`.slice(0, 160),
        kind: 'clawback',
        base_cents: -Number(atual.base_cents),
        rate_bp: Number(atual.rate_bp),
        amount_cents: -Number(atual.amount_cents),
        status: 'accrued',
        accrued_at: now,
        created_at: now
      }, sp));
      return { ...resumo('clawback'), affiliateClawbackId: Number(id) };
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  // ── Leitura ─────────────────────────────────────────────────────────

  /** Somas por status de um afiliado (ou de todos), em centavos. */
  static async totalsByAffiliate(affiliateIds = null) {
    let consulta = getDb()('affiliate_commissions')
      .select('affiliate_id', 'status')
      .sum({ cents: 'amount_cents' })
      .count({ n: '*' })
      .groupBy('affiliate_id', 'status');
    if (affiliateIds) consulta = consulta.whereIn('affiliate_id', affiliateIds);
    const linhas = await consulta;
    const mapa = new Map();
    for (const linha of linhas) {
      const id = Number(linha.affiliate_id);
      if (!mapa.has(id)) mapa.set(id, { accruedCents: 0, inPayoutCents: 0, paidCents: 0, reversedCents: 0, heldCents: 0 });
      const alvo = mapa.get(id);
      const cents = Number(linha.cents) || 0;
      if (linha.status === 'accrued') alvo.accruedCents += cents;
      else if (linha.status === 'in_payout') alvo.inPayoutCents += cents;
      else if (linha.status === 'paid') alvo.paidCents += cents;
      else if (linha.status === 'reversed') alvo.reversedCents += cents;
      else if (linha.status === 'held') alvo.heldCents += cents;
    }
    return mapa;
  }

  static async referredCounts() {
    const linhas = await getDb()('tenants').whereNotNull('referred_by_affiliate_id')
      .select('referred_by_affiliate_id').count({ n: '*' }).groupBy('referred_by_affiliate_id');
    return new Map(linhas.map((l) => [Number(l.referred_by_affiliate_id), Number(l.n) || 0]));
  }

  /** O afiliado como o console o vê (sem hash nem token). */
  static present(linha, { totals = null, referredCount = 0, config = null } = {}) {
    if (!linha) return null;
    const vazio = { accruedCents: 0, inPayoutCents: 0, paidCents: 0, reversedCents: 0, heldCents: 0 };
    return {
      id: Number(linha.id),
      name: linha.name,
      email: linha.email,
      taxId: linha.tax_id ?? null,
      pixKey: linha.pix_key ?? null,
      pixKeyType: linha.pix_key_type ?? null,
      status: linha.status,
      rateBp: linha.rate_bp ?? null,
      months: linha.months ?? null,
      effectiveRateBp: linha.rate_bp ?? config?.rateBp ?? null,
      effectiveMonths: linha.months ?? config?.months ?? null,
      code: linha.code,
      signupUrl: affiliateSignupUrl(linha.code),
      notes: linha.notes ?? null,
      hasPassword: Boolean(linha.password_hash),
      passwordLinkOpen: Boolean(linha.password_token_hash),
      approvedAt: linha.approved_at ?? null,
      createdAt: linha.created_at ?? null,
      referredCount,
      totals: totals ?? vazio
    };
  }

  static async listForConsole() {
    const [linhas, totais, contagens, config] = await Promise.all([
      tabela().orderBy('id', 'desc'),
      AffiliateService.totalsByAffiliate(),
      AffiliateService.referredCounts(),
      affiliateConfig()
    ]);
    return {
      defaults: config,
      affiliates: linhas.map((l) => AffiliateService.present(l, {
        totals: totais.get(Number(l.id)) ?? null, referredCount: contagens.get(Number(l.id)) ?? 0, config
      }))
    };
  }

  /** Os provedores indicados por um afiliado, com a janela e o que renderam. */
  static async referralsOf(affiliate, config) {
    const tenants = await getDb()('tenants').where({ referred_by_affiliate_id: affiliate.id })
      .orderBy('id', 'desc')
      .select('id', 'name', 'slug', 'status', 'referred_at', 'created_at');
    const somas = await getDb()('affiliate_commissions').where({ affiliate_id: affiliate.id })
      .whereNot({ status: 'reversed' })
      .select('tenant_id').sum({ cents: 'amount_cents' }).groupBy('tenant_id');
    const porTenant = new Map(somas.map((s) => [Number(s.tenant_id), Number(s.cents) || 0]));
    const meses = affiliate.months ?? config.months;
    return tenants.map((t) => {
      const inicio = asDate(t.referred_at) ?? asDate(t.created_at);
      return {
        tenantId: Number(t.id),
        name: t.name,
        slug: t.slug,
        status: t.status,
        referredAt: inicio ? inicio.toISOString() : null,
        windowEndsAt: inicio ? addMonths(inicio, meses).toISOString() : null,
        commissionCents: porTenant.get(Number(t.id)) ?? 0
      };
    });
  }

  static presentCommission(linha, nomes = new Map(), { mascarar = false } = {}) {
    const nome = nomes.get(Number(linha.tenant_id)) ?? null;
    return {
      id: Number(linha.id),
      tenantId: mascarar ? undefined : Number(linha.tenant_id),
      providerName: mascarar ? maskName(nome) : nome,
      kind: linha.kind,
      // A base é o valor da fatura do provedor indicado: o console a vê; o
      // portal do afiliado não — ele fica com a taxa, o valor e a data.
      baseCents: mascarar ? undefined : Number(linha.base_cents),
      rateBp: Number(linha.rate_bp),
      amountCents: Number(linha.amount_cents),
      status: linha.status,
      accruedAt: linha.accrued_at ?? null,
      payoutId: linha.payout_id ? Number(linha.payout_id) : null,
      paymentRef: mascarar ? undefined : linha.payment_ref
    };
  }

  static async commissionsOf(affiliateId, { limit = 200, mascarar = false } = {}) {
    const linhas = await getDb()('affiliate_commissions').where({ affiliate_id: affiliateId })
      .orderBy('id', 'desc').limit(limit);
    const ids = [...new Set(linhas.map((l) => Number(l.tenant_id)))];
    const nomes = new Map(ids.length
      ? (await getDb()('tenants').whereIn('id', ids).select('id', 'name')).map((t) => [Number(t.id), t.name])
      : []);
    return linhas.map((l) => AffiliateService.presentCommission(l, nomes, { mascarar }));
  }

  /** O detalhe do console: o cadastro, os indicados, o extrato e os lotes. */
  static async detailForConsole(id) {
    const linha = await AffiliateService.findById(id);
    if (!linha) return null;
    const { default: AffiliatePayoutService } = await import('./affiliatePayoutService.js');
    const config = await affiliateConfig();
    const totais = await AffiliateService.totalsByAffiliate([linha.id]);
    const referrals = await AffiliateService.referralsOf(linha, config);
    return {
      affiliate: AffiliateService.present(linha, {
        totals: totais.get(Number(linha.id)) ?? null, referredCount: referrals.length, config
      }),
      referrals,
      commissions: await AffiliateService.commissionsOf(linha.id),
      payouts: (await AffiliatePayoutService.listForAffiliate(linha.id)).map((p) => AffiliatePayoutService.present(p))
    };
  }

  /**
   * O portal do afiliado: o link, os indicados com o nome mascarado, o extrato
   * e os lotes. Lê SÓ pelo id da sessão — não há parâmetro de caminho aqui
   * para o vizinho trocar.
   */
  static async portalOverview(affiliateId) {
    const linha = await AffiliateService.findById(affiliateId);
    if (!linha) return null;
    const { default: AffiliatePayoutService } = await import('./affiliatePayoutService.js');
    const config = await affiliateConfig();
    const totais = (await AffiliateService.totalsByAffiliate([linha.id])).get(Number(linha.id))
      ?? { accruedCents: 0, inPayoutCents: 0, paidCents: 0, reversedCents: 0, heldCents: 0 };
    const indicados = await AffiliateService.referralsOf(linha, config);
    const lotes = await AffiliatePayoutService.listForAffiliate(linha.id);
    return {
      profile: AffiliateService.portalProfile(linha, config),
      totals: totais,
      payoutMinCents: config.payoutMinCents,
      referrals: indicados.map((r) => ({
        name: maskName(r.name),
        referredAt: r.referredAt,
        windowEndsAt: r.windowEndsAt,
        active: r.status === 'active',
        commissionCents: r.commissionCents
      })),
      commissions: await AffiliateService.commissionsOf(linha.id, { limit: 200, mascarar: true }),
      payouts: lotes.filter((p) => p.status !== 'canceled').map((p) => ({
        period: p.period,
        amountCents: Number(p.amount_cents),
        status: p.status === 'sending' ? 'approved' : p.status,
        sentAt: p.sent_at ?? null,
        paidAt: p.paid_at ?? null
      }))
    };
  }

  static portalProfile(linha, config) {
    return {
      name: linha.name,
      email: linha.email,
      code: linha.code,
      signupUrl: affiliateSignupUrl(linha.code),
      rateBp: linha.rate_bp ?? config.rateBp,
      months: linha.months ?? config.months,
      pixKeyType: linha.pix_key_type ?? null,
      pixKey: maskPixKey(linha.pix_key)
    };
  }
}

export default AffiliateService;
