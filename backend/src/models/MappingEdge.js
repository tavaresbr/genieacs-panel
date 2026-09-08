import { getDb, tdb, tinsert } from '../config/database.js';

function parseWaypoints(row) {
  if (!row) return row;
  let waypoints = row.waypoints;
  if (typeof waypoints === 'string') {
    try {
      waypoints = JSON.parse(waypoints);
    } catch {
      waypoints = null;
    }
  }
  return { ...row, waypoints };
}

class MappingEdge {
  static async getAll() {
    const rows = await tdb('mapping_edges').select('*').orderBy('created_at', 'desc');
    return rows.map(parseWaypoints);
  }

  static async getByEdgeId(edgeId) {
    const row = await tdb('mapping_edges').where({ edge_id: edgeId }).first();
    return row ? parseWaypoints(row) : null;
  }

  static async create(edgeData) {
    const { edge_id, source, target, fiber_type, distance, waypoints, notes } = edgeData;
    await tinsert('mapping_edges', {
      edge_id,
      source,
      target,
      fiber_type,
      distance,
      waypoints: waypoints ? JSON.stringify(waypoints) : null,
      notes
    });
    return edge_id;
  }

  static async update(edgeId, edgeData) {
    const { source, target, fiber_type, distance, waypoints, notes } = edgeData;
    const patch = { source, target, fiber_type, distance, notes, updated_at: getDb().fn.now() };
    if (waypoints !== undefined) {
      patch.waypoints = waypoints ? JSON.stringify(waypoints) : null;
    }
    const affected = await tdb('mapping_edges').where({ edge_id: edgeId }).update(patch);
    return affected > 0;
  }

  static async delete(edgeId) {
    const affected = await tdb('mapping_edges').where({ edge_id: edgeId }).del();
    return affected > 0;
  }

  static async deleteAll() {
    return tdb('mapping_edges').del();
  }

  /**
   * Clears the map of the provider in scope.
   *
   * Edges before nodes because of the foreign key, and both through the scoped
   * handle: unqualified, this emptied every provider's plant at once.
   */
  static async resetAll() {
    await getDb().transaction(async (trx) => {
      await tdb('mapping_edges', trx).del();
      await tdb('mapping_nodes', trx).del();
    });
    return true;
  }

  /**
   * Replaces the map of the provider in scope, wholesale.
   *
   * The delete and the insert both carry the provider. Scoping one and not the
   * other is how an import would quietly take everyone else's plant with it.
   */
  static async syncData(nodes, edges) {
    await getDb().transaction(async (trx) => {
      await tdb('mapping_edges', trx).del();
      await tdb('mapping_nodes', trx).del();

      if (nodes.length > 0) {
        await tinsert('mapping_nodes', nodes.map((n) => ({
          node_id: n.node_id,
          type: n.type,
          name: n.name,
          latitude: n.latitude,
          longitude: n.longitude,
          capacity: n.capacity,
          splitter: n.splitter,
          pppoe: n.pppoe,
          notes: n.notes
        })), trx);
      }

      if (edges.length > 0) {
        await tinsert('mapping_edges', edges.map((e) => ({
          edge_id: e.edge_id,
          source: e.source,
          target: e.target,
          fiber_type: e.fiber_type,
          distance: e.distance,
          waypoints: e.waypoints ? JSON.stringify(e.waypoints) : null,
          notes: e.notes
        })), trx);
      }
    });
    return true;
  }
}

export default MappingEdge;
