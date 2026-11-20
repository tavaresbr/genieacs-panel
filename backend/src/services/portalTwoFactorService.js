import crypto from 'node:crypto';
import SgpLink from '../models/SgpLink.js';
import Setting from '../models/Setting.js';
import CustomerAccount from '../models/CustomerAccount.js';
import WaConversation from '../models/WaConversation.js';
import WaOptOut from '../models/WaOptOut.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WaSendService from './waSendService.js';
import { DEFAULT_LOCALE, translate } from '../i18n/index.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
/** Entre um envio e o próximo da mesma conta. */
const RESEND_AFTER_MS = 60 * 1000;

const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/**
 * A segunda etapa do portal: um código de 6 dígitos por WhatsApp, pedido nas
 * ações sensíveis (revelar a senha do Wi-Fi, trocar Wi-Fi, trocar a senha).
 *
 * Desligado até o provedor ligar (`portalTwoFactor`). Ligado, só vale para quem
 * PODE receber: com número no vínculo, conta de atendimento do WhatsApp e sem
 * "não perturbe" de serviço. Quem não pode segue sem a segunda etapa e a
 * dispensa vai para a trilha — trancar o cliente fora é pior do que a
 * proteção que se perderia. O código só existe em claro na mensagem: no banco
 * fica o hash, com validade, tentativas e uso único.
 */
class PortalTwoFactorService {
  static async isEnabled() {
    return String(await Setting.getByKey('portalTwoFactor') ?? '') === 'true';
  }

  /** O que é preciso para entregar: o número e a conta. `null` se não dá. */
  static async channelFor(account) {
    const [link] = await SgpLink.getByDeviceIds([String(account.device_id)]);
    const phone = normalizarTelefoneBr(link?.phone_manual) || normalizarTelefoneBr(link?.phone_e164);
    if (!phone) return null;
    const wa = await WhatsAppAccount.getForPurpose('support');
    if (!wa) return null;
    if ((await WaOptOut.activePhones([phone], 'service')).has(phone)) return null;
    return { phone, wa };
  }

  /**
   * Gera e enfileira um código.
   * @returns {Promise<{status: 'sent'|'throttled'|'unavailable'}>}
   */
  static async send(account, now = Date.now()) {
    const channel = await this.channelFor(account);
    if (!channel) return { status: 'unavailable' };
    const sentAt = account.otp_sent_at ? new Date(account.otp_sent_at).getTime() : 0;
    if (now - sentAt < RESEND_AFTER_MS) return { status: 'throttled' };
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    try {
      const conversation = await WaConversation.ensure({
        accountId: channel.wa.id,
        externalThreadId: `${channel.phone}@s.whatsapp.net`,
        waPhone: channel.phone,
        waLid: null,
        pushName: null
      });
      const body = translate(DEFAULT_LOCALE, 'whatsapp.portal.otp', { code });
      await WaSendService.enqueue({ conversationId: conversation.id, body, userId: null, source: 'alert' });
    } catch (error) {
      console.warn(`[portal] código 2FA não enfileirado: ${String(error?.code || error?.message).replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
      return { status: 'unavailable' };
    }
    await CustomerAccount.setOtp(account.id, { hash: hashCode(code), expiresAt: new Date(now + CODE_TTL_MS), sentAt: new Date(now) });
    return { status: 'sent' };
  }

  /**
   * Confere o código. Uso único: acertar o consome; errar gasta uma tentativa e,
   * na quinta, o código morre.
   * @returns {Promise<'ok'|'invalid'|'expired'>}
   */
  static async verify(account, rawCode, now = Date.now()) {
    const fresh = await CustomerAccount.getById(account.id);
    const code = String(rawCode ?? '').replace(/\D/g, '');
    const expires = fresh?.otp_expires_at ? new Date(fresh.otp_expires_at).getTime() : 0;
    if (!fresh?.otp_hash || expires < now || Number(fresh.otp_attempts) >= MAX_ATTEMPTS) {
      if (fresh?.otp_hash) await CustomerAccount.clearOtp(account.id);
      return 'expired';
    }
    const expected = Buffer.from(fresh.otp_hash, 'hex');
    const given = Buffer.from(hashCode(code), 'hex');
    if (code.length === 6 && expected.length === given.length && crypto.timingSafeEqual(expected, given)) {
      await CustomerAccount.clearOtp(account.id);
      return 'ok';
    }
    await CustomerAccount.bumpOtpAttempt(account.id);
    if (Number(fresh.otp_attempts) + 1 >= MAX_ATTEMPTS) await CustomerAccount.clearOtp(account.id);
    return 'invalid';
  }
}

export default PortalTwoFactorService;
