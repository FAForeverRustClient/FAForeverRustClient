// The `faf-bo/1` envelope a run of the BO recorder produces, and the two
// derivations the panes share.
//
// Ported from the analyser in the BO recorder's own front end
// (`bo-sheppy`, `feat/bo-recorder-analyzer`), which is where this format and
// these derivations were worked out. Kept as a port rather than a dependency
// because that project is a web service with its own build, and what is needed
// here is two pure functions over a document.
//
// Parsed here rather than in Rust on purpose: no rule in the domain reasons
// about a recorded run. Nothing filters on it, nothing scores it, and it is a
// drawing for one pane. Modelling its dozen nested shapes in the domain would
// put them in every generated binding and every conformance fixture to buy a
// type check this file can do for itself.
//
// Every time in the envelope is milliseconds of game time, never ticks.

export type BoNode = {
  name: string;
  description: string;
  category: string;
  startTime: number;
  finishTime: number | null;
  entityId: string;
  unitId: string | null;
  x: number;
  z: number;
  builds: BoNode[];
};

export type Marker = { type: string; name: string; x: number; z: number };

export type Envelope = {
  schema: string;
  meta: {
    name: string;
    durationMs: number;
    map: {
      name: string;
      sizeX: number | null;
      sizeZ: number | null;
      playable: { x0: number; z0: number; x1: number; z1: number } | null;
    };
  };
  bo: BoNode;
  eco: { fields: string[]; labels: Record<string, string>; rows: number[][] };
  markers: Marker[];
  paths: {
    id: string;
    name: string;
    cat: string;
    ordinal: number;
    birth: number;
    points: { t: number; x: number; z: number }[];
  }[];
};

export type Bar = {
  key: string;
  name: string;
  cat: string;
  start: number;
  end: number | null;
  entityId: string;
};

export type Lane = {
  /** Entity id of the unit that owns this lane: the key both panes hover on. */
  id: string;
  name: string;
  cat: string;
  bars: Bar[];
};

/**
 * Bounds on a document the panes are willing to draw. A training run is a few
 * minutes of one player's opening; these leave room for a whole game and stop
 * a document that would hang or exhaust the page. `durationMs` sizes the flow
 * chart and its minute ticks, so an infinite one (`1e309` in the JSON) looped
 * for ever and a huge finite one drew a chart kilometres wide.
 */
const MAX_DURATION_MS = 3 * 60 * 60 * 1000;
const MAX_BUILD_NODES = 20_000;
const MAX_BUILD_DEPTH = 200;
const MAX_MARKERS = 20_000;
const MAX_PATHS = 10_000;
const MAX_PATH_POINTS = 500_000;
const MAX_DOCUMENT_CHARS = 8 * 1024 * 1024;
const MAX_ROUTE_POINTS = 100_000;
const MAX_SNAP_CHECKS = 2_000_000;
const MAX_COORDINATE = 1_000_000;
const MAX_ECO_VALUES = 500_000;

type JsonObject = Record<string, unknown>;
type Path = Envelope["paths"][number];

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 4096;
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isTime = (value: unknown): value is number =>
  isFiniteNumber(value) && value >= 0 && value <= MAX_DURATION_MS;
const isCoordinate = (value: unknown): value is number =>
  isFiniteNumber(value) && Math.abs(value) <= MAX_COORDINATE;

/**
 * Check every field used by the panes and index the first node for each id.
 * Reclaim leaves legitimately reuse their producer's id. Walk with a stack:
 * validation must not be the thing a deep tree overflows.
 */
function buildTreeIndex(root: unknown): Map<string, BoNode> | null {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  const index = new Map<string, BoNode>();
  let nodes = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_BUILD_NODES || depth > MAX_BUILD_DEPTH || !isObject(node)) return null;
    if (
      !isText(node.name) || !isText(node.category) || !isText(node.entityId)
      || !isTime(node.startTime)
      || (node.finishTime !== null && (!isTime(node.finishTime) || node.finishTime < node.startTime))
      || !isCoordinate(node.x) || !isCoordinate(node.z)
      || !Array.isArray(node.builds)
    ) return null;
    // Unused descriptive fields were absent in some older recordings.
    if (node.description === undefined) node.description = "";
    if (node.unitId === undefined) node.unitId = null;
    if (!isText(node.description) || (node.unitId !== null && !isText(node.unitId))) return null;
    if (nodes + stack.length + node.builds.length > MAX_BUILD_NODES) return null;
    if (!index.has(node.entityId)) index.set(node.entityId, node as BoNode);
    for (let i = node.builds.length - 1; i >= 0; i -= 1) {
      stack.push({ node: node.builds[i], depth: depth + 1 });
    }
  }
  return index;
}

function pathsFit(paths: unknown[]): boolean {
  if (paths.length > MAX_PATHS) return false;
  const ids = new Set<string>();
  let points = 0;
  for (const path of paths) {
    if (
      !isObject(path) || !isText(path.id) || ids.has(path.id)
      || !isText(path.name) || !isText(path.cat)
      || !Number.isSafeInteger(path.ordinal) || (path.ordinal as number) < 0
      || !isTime(path.birth) || !Array.isArray(path.points)
    ) return false;
    ids.add(path.id);
    points += path.points.length;
    if (points > MAX_PATH_POINTS) return false;
    let previous = 0;
    for (const point of path.points) {
      if (
        !isObject(point) || !isTime(point.t) || point.t < previous
        || !isCoordinate(point.x) || !isCoordinate(point.z)
      ) return false;
      previous = point.t;
    }
  }
  return true;
}

function parseMap(value: unknown): Envelope["meta"]["map"] | null {
  if (value === undefined || value === null) {
    return { name: "", sizeX: null, sizeZ: null, playable: null };
  }
  if (!isObject(value)) return null;
  const name = value.name ?? "";
  const sizeX = value.sizeX ?? null;
  const sizeZ = value.sizeZ ?? null;
  const dimension = (n: unknown): n is number | null =>
    n === null || n === 0 || (isCoordinate(n) && n >= 1);
  if (!isText(name) || !dimension(sizeX) || !dimension(sizeZ)) return null;
  let playable: Envelope["meta"]["map"]["playable"] = null;
  if (value.playable !== undefined && value.playable !== null) {
    const rect = value.playable;
    if (
      !isObject(rect) || !isCoordinate(rect.x0) || !isCoordinate(rect.z0)
      || !isCoordinate(rect.x1) || !isCoordinate(rect.z1)
      || rect.x1 < rect.x0 || rect.z1 < rect.z0
    ) return null;
    playable = { x0: rect.x0, z0: rect.z0, x1: rect.x1, z1: rect.z1 };
  }
  return { name, sizeX: sizeX || null, sizeZ: sizeZ || null, playable };
}

function parseEco(value: unknown): Envelope["eco"] | null {
  if (value === undefined || value === null) return { fields: [], labels: {}, rows: [] };
  if (!isObject(value)) return null;
  const fields: unknown = value.fields ?? [];
  const labels: unknown = value.labels ?? {};
  const rows: unknown = value.rows ?? [];
  if (
    !Array.isArray(fields) || fields.length > 128 || !fields.every(isText)
    || !isObject(labels) || !Object.values(labels).every(isText)
    || !Array.isArray(rows) || rows.length > 50_000
    || rows.length * (fields.length + 1) > MAX_ECO_VALUES
  ) return null;
  let previous = 0;
  for (const row of rows) {
    if (
      !Array.isArray(row) || row.length !== fields.length + 1
      || !row.every(isFiniteNumber) || !isTime(row[0]) || row[0] < previous
    ) return null;
    previous = row[0];
  }
  return { fields, labels: labels as Record<string, string>, rows: rows as number[][] };
}

/** First sample at or after time, or strictly after it for an inclusive end. */
function pointIndex(points: Path["points"], time: number, after = false): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (points[mid].t < time || (after && points[mid].t === time)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function reclaimRun(builds: BoNode[], start: number) {
  let end = start;
  let from = Number.POSITIVE_INFINITY;
  let to = 0;
  while (end < builds.length && builds[end].category === "reclaim") {
    const node = builds[end];
    from = Math.min(from, node.startTime);
    to = Math.max(to, node.finishTime ?? node.startTime);
    end += 1;
  }
  return { end, from, to };
}

/** Bound combinations, not just individual arrays, before creating SVG data. */
function routesFit(env: Envelope, nodes: Map<string, BoNode>): boolean {
  const mass = env.markers.filter((m) => m.type === "Mass").length;
  const hydro = env.markers.filter((m) => m.type === "Hydrocarbon").length;
  let points = 0;
  let snapChecks = 0;
  for (const path of env.paths) {
    const node = nodes.get(path.id);
    if (!node || node.builds.length === 0) points += path.points.length;
    else {
      points += 1;
      for (let i = 0; i < node.builds.length;) {
        const child = node.builds[i];
        if (child.category === "reclaim") {
          const run = reclaimRun(node.builds, i);
          points += pointIndex(path.points, run.to, true) - pointIndex(path.points, run.from);
          i = run.end;
        } else {
          points += 1;
          snapChecks += child.category === "mex" ? mass : child.category === "power" ? hydro : 0;
          i += 1;
        }
        if (points > MAX_ROUTE_POINTS || snapChecks > MAX_SNAP_CHECKS) return false;
      }
    }
    if (points > MAX_ROUTE_POINTS) return false;
  }
  return true;
}

/**
 * Is this parsed JSON an envelope this pane can draw?
 *
 * The document arrives over the network from a repository, so it is checked
 * rather than trusted. Every consumed field and the total derivation cost are
 * checked before returning the typed document. A run missing map
 * dimensions is still valid and still draws its flow; the map pane says why it
 * cannot draw itself.
 */
export function parseEnvelope(text: string): Envelope | null {
  if (!text || text.length > MAX_DOCUMENT_CHARS) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(value) || value.schema !== "faf-bo/1" || !isObject(value.meta)) return null;
  const duration = value.meta.durationMs;
  if (
    typeof duration !== "number"
    || !Number.isFinite(duration)
    || duration < 1
    || duration > MAX_DURATION_MS
  ) {
    return null;
  }
  const nodes = buildTreeIndex(value.bo);
  const map = parseMap(value.meta.map);
  const eco = parseEco(value.eco);
  if (!nodes || !map || !eco || !isText(value.meta.name)) return null;
  if (!Array.isArray(value.markers) || value.markers.length > MAX_MARKERS) return null;
  for (const marker of value.markers) {
    if (
      !isObject(marker) || !isText(marker.type) || !isText(marker.name)
      || !isCoordinate(marker.x) || !isCoordinate(marker.z)
    ) return null;
  }
  if (!Array.isArray(value.paths) || !pathsFit(value.paths)) return null;
  value.meta.map = map;
  value.eco = eco;
  const env = value as Envelope;
  return routesFit(env, nodes) ? env : null;
}

/**
 * One palette for both panes.
 *
 * A bar in the flow and the route it belongs to on the map have to be the same
 * colour or the pairing has to be re-learned every time the eye moves across.
 * Literal rather than tokens for that reason: these are data categories, not
 * interface surfaces, and they must stay the same in both themes so that two
 * people looking at the same run describe it the same way.
 */
export const CAT_COLOR: Record<string, string> = {
  acu: "#b39ddb",
  factory: "#8d6e63",
  engie: "#4dd0e1",
  mex: "#66bb6a",
  power: "#ffd54f",
  reclaim: "#ff8a65",
  structure: "#90a4ae",
  unit: "#ef5350",
  bomber: "#ec407a",
  interceptor: "#29b6f6",
};

/** The colour a leg is painted while the unit was actually reclaiming. */
export const RECLAIM_COLOR = "#fdd835";

export const catColor = (cat: string): string =>
  Object.prototype.hasOwnProperty.call(CAT_COLOR, cat) ? CAT_COLOR[cat] : CAT_COLOR.unit;

/**
 * Split the two air types worth telling apart out of the coarse `unit` bucket.
 *
 * Everything else stays `unit`, which deliberately lumps the whole offensive
 * land line together: what matters there is where the army went, not which
 * chassis it was. Matched on the display name rather than the blueprint id,
 * because ids differ per faction while the names do not.
 */
export function refineCat(cat: string, name: string): string {
  if (cat !== "unit") return cat;
  const n = name.toLowerCase();
  if (n.includes("bomber") || n.includes("gunship")) return "bomber";
  if (n.includes("interceptor") || n.includes("fighter")) return "interceptor";
  return "unit";
}

/** mm:ss from milliseconds of game time. */
export function mmss(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Flatten the build tree into one lane per producer.
 *
 * A lane belongs to any unit that produced something: the ACU, the factories,
 * the engineers. A unit that never builds is a bar on the lane of whoever built
 * it, not a lane of its own. That is the shape a player already reads a build
 * order in, where the factory emits engineers and each engineer branches off to
 * do its own work.
 *
 * Depth first in build order, so a producer sits directly above what it
 * produced rather than being separated from it by an unrelated branch.
 */
export function toLanes(root: BoNode): Lane[] {
  const lanes: Lane[] = [];

  const walk = (node: BoNode) => {
    if (node.builds.length === 0) return;
    lanes.push({
      id: node.entityId,
      name: node.name,
      cat: refineCat(node.category, node.name),
      bars: node.builds.map((b, i) => ({
        key: `${b.entityId}-${b.startTime}-${i}`,
        name: b.name,
        cat: refineCat(b.category, b.name),
        start: b.startTime,
        end: b.finishTime,
        entityId: b.entityId,
      })),
    });
    for (const child of node.builds) walk(child);
  };

  walk(root);
  return lanes;
}

export type MarkerPath = {
  id: string;
  name: string;
  cat: string;
  ordinal: number;
  birth: number;
  /** Built from build sites (a builder's clean route) rather than the raw trail. */
  derived: boolean;
  points: { x: number; z: number; reclaim: boolean }[];
};

/**
 * Rebuild each unit's route from the places it *worked*, not its raw trail.
 *
 * The recorder stores a dense, GPS-like position sample, which draws as a noisy
 * scribble. A build order is really about the sequence of build sites: an
 * engineer that walks to one mass point, builds it, then walks to the next
 * should read as a single edge between the two, not as every step in between.
 * So a builder's route becomes [spawn, site, site, ...], and a structure
 * standing on a resource point is snapped onto that point so the line lands on
 * the icon it built.
 *
 * Reclaim is the exception. Connecting each reclaimed prop draws a wild zigzag
 * across the whole field, because an attack-move reclaim touches hundreds of
 * scattered props. So the unit's recorded trail for that window is spliced back
 * in, flagged, and the map paints it as the sweep it actually was.
 *
 * A unit that never built anything keeps its recorded trail: it has no sites to
 * connect, and collapsing it to a single point would draw nothing.
 */
export function markerPaths(env: Envelope): MarkerPath[] {
  // Index producers by entity id. Reclaim and other in-place actions are
  // recorded as children that reuse their builder's entity id and carry no
  // builds of their own, so keeping the first hit of a depth-first walk means
  // the builder wins over those leaves instead of being clobbered to a point.
  const nodes = new Map<string, BoNode>();
  const walk = (n: BoNode) => {
    if (!nodes.has(n.entityId)) nodes.set(n.entityId, n);
    n.builds.forEach(walk);
  };
  walk(env.bo);

  const mass = env.markers.filter((m) => m.type === "Mass");
  const hydro = env.markers.filter((m) => m.type === "Hydrocarbon");
  // Map-relative, so it holds on a 5 km map and a 20 km one alike. Tight, so
  // only a structure genuinely sitting on a resource point snaps and a
  // free-placed building keeps the spot it was put on.
  const snapDist = (env.meta.map.sizeX ?? 256) / 50;

  const nearest = (x: number, z: number, pool: Marker[]): Marker | null => {
    let best: Marker | null = null;
    let bestDistance = snapDist * snapDist;
    for (const m of pool) {
      const d = (m.x - x) ** 2 + (m.z - z) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        best = m;
      }
    }
    return best;
  };

  const snap = (b: BoNode) => {
    const pool = b.category === "mex" ? mass : b.category === "power" ? hydro : null;
    const hit = pool ? nearest(b.x, b.z, pool) : null;
    return hit ? { x: hit.x, z: hit.z } : { x: b.x, z: b.z };
  };

  return env.paths.map((p): MarkerPath => {
    const node = nodes.get(p.id);
    const base = { id: p.id, name: p.name, ordinal: p.ordinal, birth: p.birth };
    if (!node || node.builds.length === 0) {
      return {
        ...base,
        cat: refineCat(p.cat, p.name),
        derived: false,
        points: p.points.map((q) => ({ x: q.x, z: q.z, reclaim: false })),
      };
    }

    const raw = p.points;
    const points: MarkerPath["points"] = [{ x: node.x, z: node.z, reclaim: false }];
    for (let i = 0; i < node.builds.length; ) {
      const b = node.builds[i];
      if (b.category !== "reclaim") {
        points.push({ ...snap(b), reclaim: false });
        i += 1;
        continue;
      }
      // The consecutive reclaim run, spliced in as recorded. A point is painted
      // only while it sits inside an individual reclaim's window: the gaps
      // between actions are travel, and a drive between two reclaim sites
      // should not read as reclaiming the whole way.
      const run = reclaimRun(node.builds, i);
      const windows = node.builds
        .slice(i, run.end)
        .map((n) => [n.startTime - 2000, (n.finishTime ?? n.startTime) + 2000] as const)
        .sort((left, right) => left[0] - right[0]);
      // Dilated so back-to-back reclaims and the roughly one-second sampling
      // gap read as one continuous sweep, while a real drive between sites is a
      // gap well beyond this and still falls through as travel.
      // Merge once, then sweep sorted samples. Testing every sample against
      // every action made a small recording require a billion comparisons.
      const merged: Array<[number, number]> = [];
      for (const [from, to] of windows) {
        const last = merged[merged.length - 1];
        if (last && from <= last[1]) last[1] = Math.max(last[1], to);
        else merged.push([from, to]);
      }
      let interval = 0;
      const stop = pointIndex(raw, run.to, true);
      for (let qIndex = pointIndex(raw, run.from); qIndex < stop; qIndex += 1) {
        const q = raw[qIndex];
        while (interval < merged.length && merged[interval][1] < q.t) interval += 1;
        const reclaim = interval < merged.length && q.t >= merged[interval][0];
        points.push({ x: q.x, z: q.z, reclaim });
      }
      i = run.end;
    }
    return { ...base, cat: refineCat(p.cat, p.name), derived: true, points };
  });
}

/**
 * Spans where a stored resource sat at zero: the visual signature of a stall.
 *
 * Read off storage rather than income, because income dipping is ordinary and
 * storage bottoming out is not. A span still open at the end of the recording
 * is closed there.
 */
export function stallSpans(env: Envelope, field: string): { from: number; to: number }[] {
  const index = env.eco?.fields?.indexOf(field) ?? -1;
  // Also tolerate callers constructing a legacy envelope without rows.
  const rows = Array.isArray(env.eco?.rows) ? env.eco.rows : [];
  if (index < 0) return [];

  const spans: { from: number; to: number }[] = [];
  let start: number | null = null;
  for (const row of rows) {
    const t = row[0];
    if (row[index + 1] <= 1) {
      if (start === null) start = t;
    } else if (start !== null) {
      spans.push({ from: start, to: t });
      start = null;
    }
  }
  if (start !== null) spans.push({ from: start, to: env.meta.durationMs });
  return spans;
}

/** The two stored resources the flow marks stalls for. */
export type Stalls = {
  mass: { from: number; to: number }[];
  energy: { from: number; to: number }[];
};

/** Mass and energy stalls of a run, under the recorder's field names. */
export function runStalls(env: Envelope): Stalls {
  return { mass: stallSpans(env, "massStored"), energy: stallSpans(env, "engStored") };
}

/**
 * Shorten `text` to at most `max` characters, ending in an ellipsis when cut.
 *
 * The flow's lane labels sit in a fixed gutter to the left of the chart, and a
 * long unit name used to run straight off its left edge. Counting characters
 * rather than measuring pixels is approximate, which is fine: the full name is
 * always in the label's tooltip.
 */
export function ellipsize(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max < 2) return text.slice(0, Math.max(0, max));
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
