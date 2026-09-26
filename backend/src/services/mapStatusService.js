import DeviceService from './deviceService.js';
import MappingNode from '../models/MappingNode.js';
import { currentTenantId } from '../config/tenantContext.js';

/**
 * O estado ao vivo dos pontos da Topologia que têm PPPoE cadastrado: o login
 * é o elo entre o ponto desenhado no mapa e o equipamento no GenieACS.
 *
 * - `online`: informou nos últimos minutos (a mesma janela da lista de
 *   equipamentos) e o sinal está bom;
 * - `weak`: online, mas com RX abaixo de `WEAK_RX_DBM` — o mesmo limite do
 *   painel e do alerta de WhatsApp;
 * - `offline`: o equipamento existe e parou de informar;
 * - `unknown`: nenhum equipamento no ACS com esse login.
 *
 * A frota é lida inteira numa consulta; o resultado fica alguns segundos em
 * memória por provedor, para que várias telas abertas no mapa não virem uma
 * consulta cada a cada recarga.
 */
export const WEAK_RX_DBM = -27;
const cache = new Map();

const normalize = (value) => String(value ?? '').trim().toLowerCase();

export function classifyNode(device) {
  if (!device) return 'unknown';
  if (!device.online) return 'offline';
  if (device.rxPower !== null && device.rxPower < WEAK_RX_DBM) return 'weak';
  return 'online';
}

class MapStatusService {
  static CACHE_MS = 30_000;

  static clearCache() {
    cache.clear();
  }

  static async fleet() {
    const key = currentTenantId() ?? 'default';
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.devices;
    const devices = await DeviceService.getMapStatusFleet();
    cache.set(key, { devices, expiresAt: Date.now() + this.CACHE_MS });
    return devices;
  }

  static async status() {
    const nodes = (await MappingNode.getAll()).filter((node) => normalize(node.pppoe));
    const summary = { online: 0, weak: 0, offline: 0, unknown: 0 };
    if (!nodes.length) return { generatedAt: new Date().toISOString(), items: [], summary };

    const byPppoe = new Map();
    for (const device of await this.fleet()) {
      const login = normalize(device.pppoe);
      if (!login) continue;
      // Dois equipamentos com o mesmo login (troca de ONT, o antigo na
      // gaveta): vale o que informou por último.
      const current = byPppoe.get(login);
      if (!current || String(device.lastInform ?? '') > String(current.lastInform ?? '')) byPppoe.set(login, device);
    }

    const items = nodes.map((node) => {
      const device = byPppoe.get(normalize(node.pppoe)) ?? null;
      const state = classifyNode(device);
      summary[state] += 1;
      return {
        node_id: node.node_id,
        state,
        deviceId: device?.deviceId ?? null,
        rxPower: device?.rxPower ?? null,
        lastInform: device?.lastInform ?? null
      };
    });
    return { generatedAt: new Date().toISOString(), items, summary };
  }
}

export default MapStatusService;
