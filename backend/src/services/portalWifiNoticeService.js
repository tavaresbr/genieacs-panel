import SgpLink from '../models/SgpLink.js';
import Setting from '../models/Setting.js';
import WaConversation from '../models/WaConversation.js';
import WaOptOut from '../models/WaOptOut.js';
import WhatsAppAccount from '../models/WhatsAppAccount.js';
import WaSendService from './waSendService.js';
import { DEFAULT_LOCALE, translate } from '../i18n/index.js';
import { normalizarTelefoneBr } from '../utils/wa/waDestino.js';

/** No máximo um aviso por conta neste intervalo: trocar três redes seguidas é um aviso só. */
const MIN_INTERVAL_MS = 30 * 60 * 1000;
const lastSent = new Map();

/**
 * O aviso ao assinante quando o Wi-Fi dele é trocado pelo portal: se não foi
 * ele, é a primeira pista de uso indevido. Desligado até o provedor ligar
 * (`portalWifiChangeNotice`).
 *
 * Nunca lança: a troca já foi enfileirada no ONT, e um WhatsApp fora do ar não
 * pode derrubar a resposta ao assinante. O texto não leva o nome da rede nem
 * senha nenhuma. Respeita o "não perturbe" de serviço. Sem modelo da Meta
 * ligado a este aviso, só sai por número que não é o oficial, ou dentro da
 * janela de 24 horas: no resto o envio é recusado e fica no log.
 *
 * @returns {Promise<boolean>} se o aviso entrou na fila
 */
export async function notifyWifiChanged({ accountId, deviceId, now = Date.now() }) {
  try {
    if (String(await Setting.getByKey('portalWifiChangeNotice') ?? '') !== 'true') return false;
    const key = String(accountId);
    if (now - (lastSent.get(key) ?? 0) < MIN_INTERVAL_MS) return false;

    const [link] = await SgpLink.getByDeviceIds([String(deviceId)]);
    const phone = normalizarTelefoneBr(link?.phone_manual) || normalizarTelefoneBr(link?.phone_e164);
    if (!phone) return false;
    const account = await WhatsAppAccount.getForPurpose('support');
    if (!account) return false;
    if ((await WaOptOut.activePhones([phone], 'service')).has(phone)) return false;

    const conversation = await WaConversation.ensure({
      accountId: account.id,
      externalThreadId: `${phone}@s.whatsapp.net`,
      waPhone: phone,
      waLid: null,
      pushName: null
    });
    const body = translate(DEFAULT_LOCALE, 'whatsapp.portal.wifiChanged');
    await WaSendService.enqueue({ conversationId: conversation.id, body, userId: null, source: 'alert' });
    lastSent.set(key, now);
    return true;
  } catch (error) {
    console.warn(`[portal] aviso de troca de Wi-Fi não enfileirado: ${String(error?.code || error?.message).replace(/[\r\n]+/g, ' ').slice(0, 200)}`);
    return false;
  }
}

export default { notifyWifiChanged };
