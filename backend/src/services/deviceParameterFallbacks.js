/**
 * Where the panel looks for a subscriber login and an optical RX reading when
 * the operator's VirtualParameters do not answer.
 *
 * Both figures are read through VirtualParameters (`vpPppoeUsername`,
 * `vpRxPower`), which are scripts an operator installs into GenieACS by hand.
 * An install that never received them — or received them under other names —
 * answers with nothing at all, and the consequences run well past two empty
 * columns: with no login on file no customer account is generated, and with no
 * account there is nothing for an SGP contract to match, so the Subscriber,
 * Customer ID and SGP columns all go blank together while the ONT has been
 * reporting its login and its RX power in its own data model the whole time.
 *
 * These candidates are consulted only after the configured VirtualParameter
 * came back empty, so an install whose scripts do answer reads exactly as it
 * did before.
 */

/** Beyond this many WAN objects a fallback is guesswork, not a lookup. */
const WAN_SCAN_LIMIT = 8;

/**
 * The concrete paths the device list asks GenieACS to project. GenieACS only
 * returns what a projection names, so the common indices have to be spelled
 * out; the resolver below then walks whatever came back, which is how an ONT
 * that numbers its WAN objects differently is still read on the detail page,
 * where the whole `WANDevice` subtree is projected.
 */
export const PPPOE_FALLBACK_PATHS = Object.freeze([
  ...[1, 2].flatMap((wan) =>
    [1, 2].flatMap((connection) =>
      [1, 2, 3].map((ppp) =>
        `InternetGatewayDevice.WANDevice.${wan}.WANConnectionDevice.${connection}`
        + `.WANPPPConnection.${ppp}.Username`
      )
    )
  ),
  // TR-181 data model, used by the ONTs that report `Device.` rather than
  // `InternetGatewayDevice.`
  'Device.PPP.Interface.1.Username',
  'Device.PPP.Interface.2.Username'
]);

/**
 * Optical RX power as the ONT vendors expose it. GPON diagnostics never made
 * it into TR-098, so every vendor put the reading under its own extension
 * object; TR-181 finally standardized it as
 * `Device.Optical.Interface.{i}.OpticalSignalLevel`.
 *
 * This list is a fast path, not the strategy. Naming an object here means a
 * projection can ask for it by name and a single request answers; the scan
 * below is what actually makes the reading findable, because no list of
 * vendor object names is ever complete. A path here that no ONT in the fleet
 * has costs nothing but its own length in the query string.
 */
export const RX_POWER_FALLBACK_PATHS = Object.freeze([
  // Nokia / Alcatel-Lucent (ALCL) G-series
  'InternetGatewayDevice.WANDevice.1.X_ALU-COM_GponInterfaceConfig.RXPower',
  // Huawei HG/EG series
  'InternetGatewayDevice.WANDevice.1.X_HW_GponInterfaceConfig.RXPower',
  // ZTE F-series
  'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_WANPONInterfaceConfig.RXPower',
  // FiberHome
  'InternetGatewayDevice.WANDevice.1.X_FH_GponInterfaceConfig.RXPower',
  // China Telecom / China Unicom / China Mobile profiles, shipped by several
  // ODM firmwares sold under other brands
  'InternetGatewayDevice.WANDevice.1.X_CT-COM_GponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_CU_GponInterfaceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.X_CMCC_GponInterfaceConfig.RXPower',
  // The misspelling is the firmware's, not a typo here: several ONU builds
  // ship the object as "InterafceConfig" and GenieACS stores what it is told.
  'InternetGatewayDevice.WANDevice.1.X_GponInterafceConfig.RXPower',
  'InternetGatewayDevice.WANDevice.1.WANPONInterfaceConfig.RXPower',
  // TR-181, in units of 0.1 dBm
  'Device.Optical.Interface.1.OpticalSignalLevel'
]);

/**
 * A GPON ONT that is lit reads somewhere between roughly -30 dBm (the receiver
 * floor) and -8 dBm (too hot). The window is deliberately wider than that: it
 * is here to reject a reading in the wrong unit, not to judge the link.
 */
const RX_POWER_MIN_DBM = -40;
const RX_POWER_MAX_DBM = -0.01;

/**
 * The same reading is published as dBm, as tenths and as hundredths depending
 * on the firmware, and nothing in the value says which. The scale is therefore
 * inferred: the first one that lands inside the physically possible window is
 * the one the firmware meant. It is unambiguous in practice because the
 * alternatives are an order of magnitude apart — -2500 is -25 dBm at a
 * hundredth and an impossible -250 dBm at a tenth.
 */
const RX_POWER_SCALES = Object.freeze([1, 10, 100]);

/**
 * Reads a number out of whatever the ONT reported — a number, a numeric
 * string, or a string carrying its unit, as in "-21.53 dBm".
 */
function parseReading(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const numeric = Number.parseFloat(match[0].replace(',', '.'));
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Normalizes a vendor RX reading to dBm, or returns null when no scale makes
 * it a possible optical power. Exactly zero is one of those: it is what an
 * ONT with no reading to give publishes, and shown as 0 dBm it would read as
 * the strongest signal in the fleet.
 */
export function normalizeRxPowerReading(value) {
  const numeric = parseReading(value);
  if (numeric === null || numeric === 0) return null;

  for (const scale of RX_POWER_SCALES) {
    const scaled = numeric / scale;
    if (scaled >= RX_POWER_MIN_DBM && scaled <= RX_POWER_MAX_DBM) {
      return Math.round(scaled * 100) / 100;
    }
  }
  return null;
}

/**
 * Names a vendor might have given the reading. Anchored on purpose: an ONT
 * that also publishes `RXPowerThreshold` or `RXPowerAlarm` must not have a
 * threshold read back to a technician as the signal on the fibre.
 */
const RX_POWER_NAMES =
  /^(?:rx_?power|rx_?optical_?power|rx_?optical_?level|rx_?level|optical_?rx_?power|optical_?signal_?level)$/i;

/**
 * How much of a device document the scan is allowed to walk. A GenieACS
 * document is operator data of unbounded shape, and a lookup that reads a
 * column has no business touching every node of it.
 */
const SCAN_NODE_BUDGET = 400;
const SCAN_MAX_DEPTH = 3;

/** The named (non-index, non-metadata) children of a GenieACS object node. */
function namedChildren(node) {
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).filter(
    ([key, value]) => !key.startsWith('_') && value && typeof value === 'object'
  );
}

/**
 * Collects every parameter under `node` whose own name says it is an RX
 * optical reading, as `{ path, node }`, walking no deeper and no wider than
 * the budget above.
 */
function collectRxCandidates(node, prefix, depth, budget, found) {
  if (depth > SCAN_MAX_DEPTH || budget.left <= 0) return;
  for (const [key, child] of namedChildren(node)) {
    if (budget.left-- <= 0) return;
    const path = `${prefix}.${key}`;
    if (RX_POWER_NAMES.test(key)) {
      found.push({ path, node: child });
      continue;
    }
    collectRxCandidates(child, path, depth + 1, budget, found);
  }
}

/**
 * Finds an optical RX reading by what the parameter is called rather than by
 * where a particular vendor put it.
 *
 * The catalogue above can only list object names someone has already seen; a
 * fleet running anything else reads N/A for every row with the value sitting
 * right there in the document. Every vendor does agree on the leaf name,
 * though — it is `RXPower` or a spelling of it — so the name is what this
 * matches on, and the value still has to survive `normalizeRxPowerReading`
 * before it is believed.
 */
export function findRxPowerReading(item, readValue) {
  const candidates = [];
  const budget = { left: SCAN_NODE_BUDGET };

  for (const [wanKey, wanDevice] of indexedChildren(item?.InternetGatewayDevice?.WANDevice)) {
    collectRxCandidates(
      wanDevice,
      `InternetGatewayDevice.WANDevice.${wanKey}`,
      1,
      budget,
      candidates
    );
  }
  for (const [key, iface] of indexedChildren(item?.Device?.Optical?.Interface)) {
    collectRxCandidates(iface, `Device.Optical.Interface.${key}`, 1, budget, candidates);
  }

  for (const candidate of candidates) {
    const value = normalizeRxPowerReading(readValue(candidate.node));
    if (value !== null) return { value, path: candidate.path };
  }
  return null;
}

/** The numeric children of a GenieACS object node, in index order. */
function indexedChildren(node) {
  if (!node || typeof node !== 'object') return [];
  return Object.keys(node)
    .filter((key) => /^\d+$/.test(key))
    .sort((a, b) => Number(a) - Number(b))
    .slice(0, WAN_SCAN_LIMIT)
    .map((key) => [key, node[key]]);
}

/** A login GenieACS stores as an empty string is a gap, not a subscriber. */
function readLogin(node, readValue) {
  const value = readValue(node);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Walks the WAN tree for a PPPoE login, whatever indices the ONT used, and
 * reports the path it was found at so the detail page can say where a value
 * that no VirtualParameter produced actually came from.
 *
 * The caller supplies the reader so that GenieACS's value nodes are unwrapped
 * the one way the rest of the panel unwraps them.
 */
export function findPppoeUsername(item, readValue) {
  for (const [wanKey, wanDevice] of indexedChildren(item?.InternetGatewayDevice?.WANDevice)) {
    for (const [connKey, connectionDevice] of indexedChildren(wanDevice?.WANConnectionDevice)) {
      for (const [pppKey, connection] of indexedChildren(connectionDevice?.WANPPPConnection)) {
        const value = readLogin(connection?.Username, readValue);
        if (value) {
          return {
            value,
            path: `InternetGatewayDevice.WANDevice.${wanKey}.WANConnectionDevice.${connKey}`
              + `.WANPPPConnection.${pppKey}.Username`
          };
        }
      }
    }
  }

  for (const [key, iface] of indexedChildren(item?.Device?.PPP?.Interface)) {
    const value = readLogin(iface?.Username, readValue);
    if (value) return { value, path: `Device.PPP.Interface.${key}.Username` };
  }

  return null;
}

export default {
  PPPOE_FALLBACK_PATHS,
  RX_POWER_FALLBACK_PATHS,
  findPppoeUsername,
  findRxPowerReading,
  normalizeRxPowerReading
};
