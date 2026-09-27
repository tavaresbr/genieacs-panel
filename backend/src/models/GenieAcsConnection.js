import { tdb, tinsert } from '../config/database.js';
import { TenantCache } from '../config/tenantCache.js';

/** Os modos que existem. `agent` entra quando o agente existir. */
export const CONNECTION_MODES = Object.freeze(['direct', 'tunnel']);

const DEFAULT_MODE = 'direct';

// Toda requisição ao ACS pergunta o modo; 30 s de cache tiram essa leitura do
// caminho quente, e gravar apaga o cache do provedor na hora.
const cache = new TenantCache(30_000);

/**
 * Como o painel chega ao GenieACS do provedor em escopo
 * (`tenant_genieacs_connections`). Sem linha, `direct`.
 */
class GenieAcsConnection {
  static async mode() {
    const guardado = cache.get();
    if (guardado) return guardado;
    const row = await tdb('tenant_genieacs_connections').first('mode');
    const mode = CONNECTION_MODES.includes(row?.mode) ? row.mode : DEFAULT_MODE;
    cache.set(mode);
    return mode;
  }

  static async setMode(mode) {
    if (!CONNECTION_MODES.includes(mode)) throw new Error(`Unknown GenieACS connection mode: ${mode}`);
    const existe = await tdb('tenant_genieacs_connections').first('id');
    if (existe) {
      await tdb('tenant_genieacs_connections').update({ mode, updated_at: new Date() });
    } else {
      await tinsert('tenant_genieacs_connections', { mode });
    }
    cache.invalidate();
  }

  /** Para os testes. */
  static clearCache() {
    cache.clear();
  }
}

export default GenieAcsConnection;
