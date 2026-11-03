import crypto from 'node:crypto';
import { getDb } from '../config/database.js';
import { TICKET_GRACE_DAYS } from '../config/retention.js';
import { DEVELOPMENT_FALLBACK } from '../config/runtimeEnv.js';

/**
 * As sessões por aparelho: o refresh token guardado só como hash, com rotação
 * e detecção de reuso (0129). Desenho em `docs/seguranca-auditoria.md` §5.
 *
 * Cada login abre uma FAMÍLIA (`family_id`). Cada `/refresh` marca o token
 * apresentado como `rotated_at` e emite o sucessor na mesma família — num
 * UPDATE condicional dentro de uma transação, como `AuthTicket.redeem`: duas
 * renovações simultâneas do mesmo token não emitem dois sucessores.
 *
 * O sucessor NÃO é sorteado: é o HMAC do token anterior com uma chave do
 * servidor (`successorOf`). É isso que deixa a folga de duas abas devolver o
 * MESMO sucessor à aba que chegou atrasada — a tabela só tem o hash dele, e
 * sorteá-lo obrigaria a guardar o valor em claro ou a abrir um galho na família.
 * Quem não tem a chave não calcula o sucessor de um token roubado.
 *
 * Um token já rotacionado, apresentado DEPOIS da folga, é reuso: alguém tem uma
 * cópia. A família inteira é revogada — a cópia e o aparelho legítimo caem
 * juntos, e a pessoa entra de novo; quem tem só a cópia, não.
 *
 * tenant-scope-exempt: tabela compartilhada, declarada em `SHARED_TABLES`. Toda
 * leitura nomeia o hash, a família ou a pessoa.
 */

/** Sete dias, renovados a cada uso: o mesmo prazo do refresh que existia. */
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A folga para duas abas renovando juntas. */
export const REFRESH_GRACE_MS = 10_000;

const SUCCESSOR_KEY = crypto
  .createHmac('sha256', process.env.JWT_SECRET || DEVELOPMENT_FALLBACK)
  .update('skygenpanel-refresh-successor-v1')
  .digest();

const USER_AGENT_MAX = 255;
const IP_MAX = 64;

function toDate(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Instante em segundos inteiros: o MySQL arredonda milissegundos. */
function wholeSecond(date) {
  return new Date(Math.floor(date.getTime() / 1000) * 1000);
}

/**
 * Um rótulo curto do aparelho, para a lista de sessões. Nada de biblioteca de
 * user agent: a tela precisa de "Chrome · Windows", não de uma impressão digital.
 */
export function describeUserAgent(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) ? 'Safari'
            : null;
  const os = /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
      : /Windows/.test(ua) ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
          : /Linux/.test(ua) ? 'Linux'
            : null;
  const parts = [browser, os].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

class RefreshToken {
  static hash(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
  }

  /** 32 bytes, base64url: vai no cookie como está, sem escapar nada. */
  static mint() {
    return crypto.randomBytes(32).toString('base64url');
  }

  /** O sucessor determinístico de um token — ver o topo do arquivo. */
  static successorOf(raw) {
    return crypto.createHmac('sha256', SUCCESSOR_KEY).update(String(raw)).digest('base64url');
  }

  static context(req) {
    const ua = req?.get?.('user-agent') ?? req?.headers?.['user-agent'] ?? null;
    return {
      userAgent: ua ? String(ua).slice(0, USER_AGENT_MAX) : null,
      ip: req?.ip ? String(req.ip).slice(0, IP_MAX) : null
    };
  }

  static async insert(db, { familyId, userId, tenantId, audience, raw, tokenVersion, userAgent, ip, now, rotated = false }) {
    await db('refresh_tokens').insert({
      family_id: familyId,
      user_id: userId,
      tenant_id: tenantId ?? null,
      audience,
      token_hash: RefreshToken.hash(raw),
      token_version: Number(tokenVersion || 0),
      expires_at: wholeSecond(new Date(now.getTime() + REFRESH_TTL_MS)),
      rotated_at: rotated ? wholeSecond(now) : null,
      user_agent: userAgent ?? null,
      ip: ip ?? null,
      created_at: wholeSecond(now),
      last_used_at: wholeSecond(now)
    });
  }

  /**
   * Abre uma família nova e devolve o valor em claro UMA vez, para o cookie.
   */
  static async startFamily({ user, audience, tenantId = null, context = {}, now = new Date() }) {
    const familyId = crypto.randomUUID();
    const raw = RefreshToken.mint();
    await RefreshToken.insert(getDb(), {
      familyId,
      userId: user.id,
      tenantId,
      audience,
      raw,
      tokenVersion: user.token_version,
      userAgent: context.userAgent,
      ip: context.ip,
      now
    });
    return { familyId, raw };
  }

  /**
   * A transição de uma versão: o refresh ANTIGO (JWT sem estado) vira a raiz
   * já rotacionada de uma família nova, e o sucessor dele é o primeiro token
   * de cookie. Reapresentar o mesmo JWT dentro da folga devolve o mesmo
   * sucessor (duas abas migrando juntas); depois dela é reuso, como qualquer
   * outro token rotacionado — o JWT antigo deixa de ser uma credencial de sete
   * dias no `localStorage` no instante em que é migrado.
   */
  static async adoptLegacy({ legacyToken, user, audience, tenantId = null, context = {}, now = new Date() }) {
    const existing = await RefreshToken.findByRaw(legacyToken);
    if (existing) return { existing };
    const familyId = crypto.randomUUID();
    const raw = RefreshToken.successorOf(legacyToken);
    try {
      await getDb().transaction(async (trx) => {
        await RefreshToken.insert(trx, {
          familyId, userId: user.id, tenantId, audience, raw: legacyToken,
          tokenVersion: user.token_version, userAgent: context.userAgent, ip: context.ip, now, rotated: true
        });
        await RefreshToken.insert(trx, {
          familyId, userId: user.id, tenantId, audience, raw,
          tokenVersion: user.token_version, userAgent: context.userAgent, ip: context.ip, now
        });
      });
    } catch (error) {
      // Duas abas migrando o mesmo JWT no mesmo instante: o índice único do
      // hash deixou entrar só uma. A outra segue pelo caminho da rotação.
      const again = await RefreshToken.findByRaw(legacyToken);
      if (again) return { existing: again };
      throw error;
    }
    return { familyId, raw };
  }

  static async findByRaw(raw) {
    if (!raw) return null;
    return (await getDb()('refresh_tokens').where({ token_hash: RefreshToken.hash(raw) }).first()) || null;
  }

  /**
   * Troca o token apresentado pelo sucessor. Devolve:
   *
   * - `{ ok: true, raw, row }` — o sucessor (novo, ou o mesmo já emitido, na folga);
   * - `{ ok: false, reason }` — `unknown`, `expired`, `revoked`, `stale_version`
   *   ou `reuse` (este último já revogou a família).
   *
   * `user` é a pessoa relida agora: a versão dela decide se a família ainda vale.
   */
  static async rotate({ raw, row, user, context = {}, now = new Date() }) {
    let current = row ?? await RefreshToken.findByRaw(raw);
    let currentRaw = raw;
    if (!current) return { ok: false, reason: 'unknown' };
    if (current.revoked_at) return { ok: false, reason: 'revoked' };
    if (Number(current.token_version || 0) !== Number(user.token_version || 0)) {
      await RefreshToken.revokeFamily(current.family_id, now);
      return { ok: false, reason: 'stale_version' };
    }

    // Até três saltos na folga: uma aba muito atrasada pode chegar depois de
    // duas rotações seguidas das outras. Mais que isso não é aba, é cópia.
    for (let salto = 0; salto < 3; salto += 1) {
      const expira = toDate(current.expires_at);
      if (!current.rotated_at && expira && expira.getTime() <= now.getTime()) {
        return { ok: false, reason: 'expired' };
      }

      if (!current.rotated_at) {
        const successorRaw = RefreshToken.successorOf(currentRaw);
        const alvo = current;
        // eslint-disable-next-line no-await-in-loop -- um salto por vez, em ordem
        const won = await getDb().transaction(async (trx) => {
          const changed = await trx('refresh_tokens')
            .where({ id: alvo.id })
            .whereNull('rotated_at')
            .whereNull('revoked_at')
            .update({ rotated_at: wholeSecond(now), last_used_at: wholeSecond(now) });
          if (changed !== 1) return false;
          await RefreshToken.insert(trx, {
            familyId: alvo.family_id,
            userId: alvo.user_id,
            tenantId: alvo.tenant_id,
            audience: alvo.audience,
            raw: successorRaw,
            tokenVersion: alvo.token_version,
            userAgent: context.userAgent ?? alvo.user_agent,
            ip: context.ip ?? alvo.ip,
            now
          });
          return true;
        });
        if (won) {
          return { ok: true, raw: successorRaw, row: await RefreshToken.findByRaw(successorRaw) };
        }
        // Outra requisição girou este mesmo token um instante antes: relê e
        // segue pelo caminho da folga logo abaixo.
        // eslint-disable-next-line no-await-in-loop -- releitura do mesmo token
        current = await RefreshToken.findByRaw(currentRaw);
        if (!current) return { ok: false, reason: 'unknown' };
        if (current.revoked_at) return { ok: false, reason: 'revoked' };
        if (!current.rotated_at) return { ok: false, reason: 'unknown' };
      }

      const girado = toDate(current.rotated_at);
      // O MySQL guarda segundos inteiros; a folga conta a partir do segundo.
      const dentroDaFolga = girado && now.getTime() - girado.getTime() <= REFRESH_GRACE_MS + 999;
      if (!dentroDaFolga) {
        await RefreshToken.revokeFamily(current.family_id, now);
        return { ok: false, reason: 'reuse', row: current };
      }
      const nextRaw = RefreshToken.successorOf(currentRaw);
      // eslint-disable-next-line no-await-in-loop -- o próximo elo da mesma família
      const next = await RefreshToken.findByRaw(nextRaw);
      if (!next || next.family_id !== current.family_id || next.revoked_at) {
        return { ok: false, reason: 'revoked' };
      }
      if (!next.rotated_at) {
        const expira = toDate(next.expires_at);
        if (expira && expira.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
        return { ok: true, raw: nextRaw, row: next, grace: true };
      }
      current = next;
      currentRaw = nextRaw;
    }
    await RefreshToken.revokeFamily(current.family_id, now);
    return { ok: false, reason: 'reuse', row: current };
  }

  static async revokeFamily(familyId, now = new Date()) {
    if (!familyId) return 0;
    return getDb()('refresh_tokens')
      .where({ family_id: String(familyId) })
      .whereNull('revoked_at')
      .update({ revoked_at: wholeSecond(now) });
  }

  /** Encerra uma família DESTA pessoa; 0 quando não é dela ou não existe. */
  static async revokeOwnFamily(userId, familyId, now = new Date()) {
    if (!familyId || typeof familyId !== 'string' || familyId.length > 36) return 0;
    return getDb()('refresh_tokens')
      .where({ family_id: familyId, user_id: Number(userId) })
      .whereNull('revoked_at')
      .update({ revoked_at: wholeSecond(now) });
  }

  static async revokeAllForUser(userId, now = new Date()) {
    return getDb()('refresh_tokens')
      .where({ user_id: Number(userId) })
      .whereNull('revoked_at')
      .update({ revoked_at: wholeSecond(now) });
  }

  /**
   * Se a família ainda vale. É o que faz "Encerrar" e "Sair" valerem já na
   * próxima requisição do token de acesso, e não quando os 15 min acabarem.
   */
  static async familyActive(familyId, userId) {
    if (!familyId || typeof familyId !== 'string') return false;
    const row = await getDb()('refresh_tokens')
      .where({ family_id: familyId, user_id: Number(userId) })
      .whereNull('revoked_at')
      .first('id');
    return Boolean(row);
  }

  /**
   * A família da sessão que acabou de mudar o próprio segundo fator passa para
   * a versão nova da pessoa — as outras continuam na antiga e caem na próxima
   * renovação. Ver `AuthController.mfaFreshTokens`.
   */
  static async adoptVersion(familyId, userId, tokenVersion) {
    if (!familyId) return 0;
    return getDb()('refresh_tokens')
      .where({ family_id: String(familyId), user_id: Number(userId) })
      .whereNull('revoked_at')
      .update({ token_version: Number(tokenVersion || 0) });
  }

  /**
   * As sessões abertas de uma pessoa: uma por família, a cabeça viva dela.
   * `created_at` é o do login (a primeira linha da família), `last_used_at` o
   * da última renovação.
   */
  static async listForUser(userId, tokenVersion, now = new Date()) {
    const db = getDb();
    const heads = await db('refresh_tokens')
      .where({ user_id: Number(userId), token_version: Number(tokenVersion || 0) })
      .whereNull('revoked_at')
      .whereNull('rotated_at')
      .where('expires_at', '>', now)
      .orderBy('id', 'desc')
      .select('family_id', 'tenant_id', 'audience', 'user_agent', 'ip', 'last_used_at', 'created_at');
    if (!heads.length) return [];
    const inicio = await db('refresh_tokens')
      .whereIn('family_id', heads.map((h) => h.family_id))
      .groupBy('family_id')
      .select('family_id')
      .min({ created_at: 'created_at' });
    const criada = new Map(inicio.map((r) => [r.family_id, r.created_at]));
    return heads.map((h) => ({ ...h, family_created_at: criada.get(h.family_id) ?? h.created_at }));
  }

  /** Apaga o que já não serve: vencido ou revogado há mais de um dia. */
  static async prune(now = new Date()) {
    const cutoff = new Date(now.getTime() - TICKET_GRACE_DAYS * 24 * 60 * 60 * 1000);
    return getDb()('refresh_tokens')
      .where('expires_at', '<', cutoff)
      .orWhere('revoked_at', '<', cutoff)
      .del();
  }
}

export default RefreshToken;
