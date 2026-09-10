import { tinsert } from '../config/database.js';

/**
 * The record of the handful of actions that leave no trace in the data itself.
 *
 * Most of what the panel does can be reconstructed afterwards by looking at
 * what changed. These cannot: revealing a stored password changes nothing, and
 * ending a membership or rotating a credential destroys the very row that would
 * have said what was there before. Those are the lines worth keeping, and this
 * table keeps them.
 *
 * Three rules shape everything below, and each of them is a way this table
 * could turn into a liability rather than a control:
 *
 *  1. NEVER the secret itself. A log that stores the password that was revealed
 *     is a second copy of every password in the panel, sitting in a table that
 *     gets read access handed out far more freely than the accounts table does
 *     — and one that, unlike the accounts table, nobody encrypted. The line
 *     says a reveal happened, whose account it was, who asked and from where.
 *     Anyone holding the line still has to go and get the password the same way
 *     the operator did, which is itself another line.
 *  2. Recording an action must never break it. See `record` below.
 *  3. The metadata field is where personal data accumulates quietly, one
 *     well-meant `...body` at a time. See `sanitizeMetadata`.
 */

/**
 * The closed vocabulary. A line is only useful if the next person can ask for
 * every occurrence of one kind of thing, which means the name has to be a value
 * and not a sentence.
 *
 * What is here is what the panel can genuinely do today. The plan also names
 * platform impersonation, which does not exist yet — the platform plane is
 * separate work — and a constant for an action nothing performs would read, to
 * the next person, as a hook that is already wired up.
 */
export const AUDIT_ACTIONS = Object.freeze({
  // An operator read back a subscriber's stored portal password, and a reset
  // hands one out just the same. Both are admin-only routes; both mean somebody
  // now holds credentials to a subscriber's account.
  PORTAL_PASSWORD_REVEALED: 'portal_password.revealed',
  PORTAL_PASSWORD_RESET: 'portal_password.reset',
  // A subscriber read their own stored WiFi key from the portal. Attributable
  // only to whoever held the portal session — which is exactly why it is worth
  // a line: paired with a `portal_password.reset` line minutes earlier, it is
  // the shape of an operator using a password they just issued themselves.
  WIFI_PASSWORD_REVEALED: 'wifi_password.revealed',
  // The team. Granting access matters as much as withdrawing it, and setting
  // somebody else's password is how one account quietly becomes another.
  OPERATOR_ADDED: 'operator.added',
  OPERATOR_ROLE_CHANGED: 'operator.role_changed',
  OPERATOR_PASSWORD_SET: 'operator.password_set',
  OPERATOR_REMOVED: 'operator.removed',
  // The two integrations whose credentials live in this database. Both hold a
  // token that reaches a system outside the panel — the ERP that knows every
  // subscriber's contract and document, and the WhatsApp server that can
  // message them.
  SGP_CONFIG_CHANGED: 'integration.sgp.config_changed',
  SGP_WEBHOOK_SECRET_ROTATED: 'integration.sgp.webhook_secret_rotated',
  WHATSAPP_CONFIG_CHANGED: 'integration.whatsapp.config_changed',
  // Where the provider's whole fleet is managed from. Since 0029 this is a
  // connection with a credential rather than a URL among the settings, which is
  // what makes it belong here: repointing it does not change a single row of
  // subscriber data, so nothing but a line says it happened — and the panel
  // that was managing one ISP's ONTs is now managing whatever answers at the
  // new address.
  GENIEACS_CONFIG_CHANGED: 'integration.genieacs.config_changed'
});

/** Who acted. The panel and the portal mean different tables by "who". */
export const ACTOR_TYPES = Object.freeze({
  OPERATOR: 'operator',
  SUBSCRIBER: 'subscriber',
  SYSTEM: 'system'
});

const MAX_METADATA_KEYS = 8;
const MAX_STRING = 120;

/**
 * Anything whose NAME suggests it carries a secret.
 *
 * A blunt instrument, and deliberately blunt: it is here to catch the future
 * call site that passes the value it just decrypted along with everything else
 * it had to hand, which is how the "never the secret itself" rule gets broken
 * — never on purpose, always by spreading an object. Matching on the key is
 * the only check available, since a password is otherwise just a short string.
 */
const SECRET_KEY = /pass|secret|token|key|hash|cipher|credential|auth|otp|pin/i;

/**
 * The metadata a line may carry, which is far less than a caller will offer.
 *
 * This field is the one that accumulates personal data without anybody deciding
 * to collect any: it starts as `{ reason }`, and three changes later somebody
 * has spread a request body into it and the log holds subscriber documents and
 * phone numbers with no retention policy and no encryption. So it takes only
 * scalars, only a few of them, and only short ones — a nested object is exactly
 * the shape a whole request body arrives in, so nesting is dropped rather than
 * flattened.
 *
 * Keys that sound like secrets are dropped silently, with one exception that is
 * not a loophole: a BOOLEAN under such a key is kept, because a boolean cannot
 * be a secret — it has two possible values and the reader already knows both.
 * That is what lets a call site record `tokenChanged: true`, which is the fact
 * worth keeping, while `token: '…'` from the same object never lands.
 *
 * Identity belongs in `target_type`/`target_id`, not here. Those are one
 * identifier, chosen at the call site, rather than whatever the handler had in
 * scope.
 */
export function sanitizeMetadata(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;

  const clean = {};
  for (const [key, value] of Object.entries(input)) {
    if (Object.keys(clean).length >= MAX_METADATA_KEYS) break;
    if (typeof value === 'boolean') clean[key] = value;
    else if (SECRET_KEY.test(key)) continue;
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'string' && value.trim()) clean[key] = value.trim().slice(0, MAX_STRING);
  }

  // NULL rather than '{}', so "carried nothing" and "carried an empty object"
  // are not two different-looking answers to the same question.
  return Object.keys(clean).length > 0 ? JSON.stringify(clean) : null;
}

/**
 * The caller's address, as the panel sees it.
 *
 * Not `ipKey` from the rate limiter: that folds an IPv6 client down to its /64
 * on purpose, because one host owning a whole prefix makes per-address limiting
 * pointless. An audit line wants the opposite — the most specific address there
 * is — so the two must not share a helper, however alike they look.
 */
function clientIp(req) {
  const address = req?.ip || req?.socket?.remoteAddress || null;
  if (!address) return null;
  return String(address).replace(/^::ffff:/, '').slice(0, 45);
}

/**
 * Who the panel says is asking.
 *
 * `req.user` is an operator's verified session; `req.customer` is the whole
 * subscriber account row, secrets included, so exactly two fields are read off
 * it and it is never passed on whole.
 */
function actorOf(req) {
  if (req?.user?.userId) {
    return {
      actor_type: ACTOR_TYPES.OPERATOR,
      actor_user_id: Number(req.user.userId),
      actor_label: String(req.user.username ?? '').slice(0, 64) || null
    };
  }
  if (req?.customer?.id) {
    return {
      actor_type: ACTOR_TYPES.SUBSCRIBER,
      // Deliberately null: the column is a foreign key into `users`, and a
      // subscriber is not one. Who they were is in the label and the target.
      actor_user_id: null,
      actor_label: String(req.customer.customer_id ?? '').slice(0, 64) || null
    };
  }
  return { actor_type: ACTOR_TYPES.SYSTEM, actor_user_id: null, actor_label: null };
}

class AuditLog {
  /**
   * Writes one line, and never throws.
   *
   * This is the whole reason the method exists rather than callers reaching for
   * `tinsert` themselves. A reveal that succeeded, or a membership that has
   * already been ended, must not turn into a 500 because the log table was full,
   * locked, or momentarily unreachable: the action is done, the caller is
   * entitled to its answer, and re-running it because the response said failure
   * would mean a second reveal — a second line's worth of exposure caused by the
   * logging.
   *
   * The cost of that choice is honest and worth stating: a deployment whose log
   * writes are failing keeps serving sensitive actions unrecorded, and only the
   * process log says so. The alternative — refusing the action when it cannot be
   * recorded — is a defensible design for a bank and the wrong one here, where
   * the panel is the only way an ISP reaches its own subscribers and a broken
   * audit table would take the support desk down with it. `console.error` is
   * what the rest of the panel already uses to make an operational failure
   * visible, and the missing line is not recoverable by any retry this code
   * could perform anyway.
   */
  static async record({
    action,
    actorType = ACTOR_TYPES.SYSTEM,
    actorUserId = null,
    actorLabel = null,
    targetType = null,
    targetId = null,
    ip = null,
    metadata = null
  }) {
    try {
      await tinsert('audit_log', {
        action: String(action).slice(0, 64),
        actor_type: actorType,
        actor_user_id: actorUserId,
        actor_label: actorLabel,
        target_type: targetType,
        target_id: targetId === null || targetId === undefined
          ? null
          : String(targetId).slice(0, 64),
        ip,
        metadata: sanitizeMetadata(metadata),
        created_at: new Date()
      });
      return true;
    } catch (error) {
      console.error(`Audit log write failed for "${action}":`, error.message);
      return false;
    }
  }

  /**
   * The same, with the actor and the address taken from the request.
   *
   * Every call site in a controller uses this one: reading the actor off the
   * verified session rather than off the body is what makes a line evidence
   * instead of a claim.
   */
  static async recordFromRequest(req, { action, targetType = null, targetId = null, metadata = null }) {
    const actor = actorOf(req);
    return this.record({
      action,
      actorType: actor.actor_type,
      actorUserId: actor.actor_user_id,
      actorLabel: actor.actor_label,
      targetType,
      targetId,
      ip: clientIp(req),
      metadata
    });
  }
}

export default AuditLog;
