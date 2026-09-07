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
 * Is this parsed JSON an envelope this pane can draw?
 *
 * The document arrives over the network from a repository, so it is checked
 * rather than trusted. What is checked is only what the panes actually read: a
 * schema tag, a duration, a build tree and the two arrays. A run missing map
 * dimensions is still valid and still draws its flow; the map pane says why it
 * cannot draw itself.
 */
export function parseEnvelope(text: string): Envelope | null {
  if (!text) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const env = value as Partial<Envelope>;
  if (env.schema !== "faf-bo/1") return null;
  if (!env.meta || typeof env.meta.durationMs !== "number" || env.meta.durationMs <= 0) {
    return null;
  }
  if (!env.bo || typeof env.bo.entityId !== "string" || !Array.isArray(env.bo.builds)) {
    return null;
  }
  if (!Array.isArray(env.markers) || !Array.isArray(env.paths)) return null;
  return env as Envelope;
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

export const catColor = (cat: string): string => CAT_COLOR[cat] ?? CAT_COLOR.unit;

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
      let j = i;
      while (j < node.builds.length && node.builds[j].category === "reclaim") j += 1;
      const windows = node.builds
        .slice(i, j)
        .map((n) => [n.startTime, n.finishTime ?? n.startTime] as const);
      const from = windows[0][0];
      const to = windows[windows.length - 1][1];
      // Dilated so back-to-back reclaims and the roughly one-second sampling
      // gap read as one continuous sweep, while a real drive between sites is a
      // gap well beyond this and still falls through as travel.
      const tolerance = 2000;
      const reclaiming = (t: number) =>
        windows.some(([a, b2]) => t >= a - tolerance && t <= b2 + tolerance);
      for (const q of raw) {
        if (q.t >= from && q.t <= to) {
          points.push({ x: q.x, z: q.z, reclaim: reclaiming(q.t) });
        }
      }
      i = j;
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
  if (index < 0) return [];

  const spans: { from: number; to: number }[] = [];
  let start: number | null = null;
  for (const row of env.eco.rows) {
    const [t, ...values] = row;
    if (values[index] <= 1) {
      if (start === null) start = t;
    } else if (start !== null) {
      spans.push({ from: start, to: t });
      start = null;
    }
  }
  if (start !== null) spans.push({ from: start, to: env.meta.durationMs });
  return spans;
}
