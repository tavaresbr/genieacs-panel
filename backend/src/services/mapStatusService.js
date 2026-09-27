import DeviceService from './deviceService.js';
import MappingNode from '../models/MappingNode.js';
import MappingEdge from '../models/MappingEdge.js';
import WaAlertService, { DEFAULT_RULES } from './waAlertService.js';
import { detectOutages } from './outageDetector.js';
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

  /** O limite da regra de queda em massa, para o mapa usar o mesmo do alerta. */
  static async outageThreshold() {
    try {
      return (await WaAlertService.getSettings()).rules.mass_outage.threshold;
    } catch {
      return DEFAULT_RULES.mass_outage.threshold;
    }
  }

  static async status() {
    const allNodes = await MappingNode.getAll();
    const nodes = allNodes.filter((node) => normalize(node.pppoe));
    const summary = { online: 0, weak: 0, offline: 0, unknown: 0 };
    if (!nodes.length) return { generatedAt: new Date().toISOString(), items: [], summary, outages: [] };

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
    // Provável rompimento: as caixas com vários clientes offline ao mesmo
    // tempo, pela mesma regra do alerta de WhatsApp (`outageDetector`).
    const offline = new Map(items
      .filter((item) => item.state === 'offline')
      .map((item) => [item.node_id, item.lastInform ? new Date(item.lastInform).getTime() : null]));
    const outages = offline.size < 2
      ? []
      : detectOutages({ nodes: allNodes, edges: await MappingEdge.getAll(), offline, threshold: await this.outageThreshold() })
        .map((outage) => ({
          node_id: outage.box.node_id,
          name: outage.box.name,
          count: outage.count,
          total: outage.total,
          since: outage.since === null ? null : new Date(outage.since).toISOString(),
          clients: outage.clients
        }));
    return { generatedAt: new Date().toISOString(), items, summary, outages };
  }
}

export default MapStatusService;
