import { tdb, tinsert } from '../config/database.js';
import { TenantCache } from '../config/tenantCache.js';

/** Os modos que existem. `agent` entra quando o agente existir. */
export const CONNECTION_MODES = Object.freeze(['direct', 'tunnel']);

/**
 * Quem administra o ACS na SaaS: `platform` (o console) ou `own` (o provedor,
 * com o servidor dele). Na self-hosted não faz diferença: lá é tudo do provedor.
 */
export const GENIEACS_OWNERSHIPS = Object.freeze(['platform', 'own']);

const DEFAULT_MODE = 'direct';
const DEFAULT_OWNERSHIP = 'platform';

// Toda requisição ao ACS pergunta o modo; 30 s de cache tiram essa leitura do
// caminho quente, e gravar apaga o cache do provedor na hora.
const cache = new TenantCache(30_000);

/**
 * Como o painel chega ao GenieACS do provedor em escopo, e quem o administra
 * (`tenant_genieacs_connections`). Sem linha, `direct` e `platform`.
 */
class GenieAcsConnection {
  static async #row() {
    const guardado = cache.get();
    if (guardado) return guardado;
    const row = await tdb('tenant_genieacs_connections').first('mode', 'ownership');
    const valor = {
      mode: CONNECTION_MODES.includes(row?.mode) ? row.mode : DEFAULT_MODE,
      ownership: GENIEACS_OWNERSHIPS.includes(row?.ownership) ? row.ownership : DEFAULT_OWNERSHIP
    };
    cache.set(valor);
    return valor;
  }

  static async #upsert(patch) {
    const existe = await tdb('tenant_genieacs_connections').first('id');
    if (existe) {
      await tdb('tenant_genieacs_connections').update({ ...patch, updated_at: new Date() });
    } else {
      await tinsert('tenant_genieacs_connections', patch);
    }
    cache.invalidate();
  }

  static async mode() {
    return (await GenieAcsConnection.#row()).mode;
  }

  static async ownership() {
    return (await GenieAcsConnection.#row()).ownership;
  }

  static async setMode(mode) {
    if (!CONNECTION_MODES.includes(mode)) throw new Error(`Unknown GenieACS connection mode: ${mode}`);
    await GenieAcsConnection.#upsert({ mode });
  }

  static async setOwnership(ownership) {
    if (!GENIEACS_OWNERSHIPS.includes(ownership)) throw new Error(`Unknown GenieACS ownership: ${ownership}`);
    await GenieAcsConnection.#upsert({ ownership });
  }

  /** Para os testes. */
  static clearCache() {
    cache.clear();
  }
}

export default GenieAcsConnection;
