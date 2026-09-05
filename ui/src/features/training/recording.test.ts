import { describe, expect, it } from "vitest";

import { markerPaths, parseEnvelope, stallSpans, toLanes, type BoNode, type Envelope } from "./recording";

// A tiny run, written by hand rather than lifted from a real recording: the
// derivations below are about shape, and a real envelope is 150 kB of noise
// around the three cases that matter.

const node = (over: Partial<BoNode> & Pick<BoNode, "entityId" | "category">): BoNode => ({
  name: over.name ?? over.category,
  description: "",
  startTime: 0,
  finishTime: null,
  unitId: null,
  x: 0,
  z: 0,
  builds: [],
  ...over,
});

function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    schema: "faf-bo/1",
    meta: {
      name: "run",
      durationMs: 60_000,
      map: { name: "Test", sizeX: 256, sizeZ: 256, playable: null },
    },
    bo: node({ entityId: "0", category: "acu", name: "ACU", x: 10, z: 10 }),
    eco: { fields: [], labels: {}, rows: [] },
    markers: [],
    paths: [],
    ...over,
  };
}

describe("parseEnvelope", () => {
  it("refuses anything that is not a run this pane can draw", () => {
    // The document arrives over the network from a repository, so what is
    // checked is what the panes actually read.
    expect(parseEnvelope("")).toBeNull();
    expect(parseEnvelope("not json")).toBeNull();
    expect(parseEnvelope("[]")).toBeNull();
    expect(parseEnvelope(JSON.stringify({ schema: "something-else" }))).toBeNull();
    // A build order with no duration cannot be laid out on a time axis, and
    // dividing by it would put every node in the same place.
    const noDuration = envelope();
    noDuration.meta.durationMs = 0;
    expect(parseEnvelope(JSON.stringify(noDuration))).toBeNull();
    expect(parseEnvelope(JSON.stringify(envelope()))).not.toBeNull();
  });
});

describe("toLanes", () => {
  it("gives a lane to every producer and to nobody else", () => {
    const root = node({
      entityId: "acu",
      category: "acu",
      builds: [
        node({
          entityId: "fac",
          category: "factory",
          name: "Land Factory",
          startTime: 5_000,
          finishTime: 30_000,
          builds: [node({ entityId: "engie", category: "engie", name: "Engineer" })],
        }),
        node({ entityId: "mex", category: "mex", name: "Mass Extractor", startTime: 40_000 }),
      ],
    });

    const lanes = toLanes(root);
    // The ACU and the factory built things; the mex and the engineer did not.
    expect(lanes.map((l) => l.id)).toEqual(["acu", "fac"]);
    // Depth first, so a producer sits directly above what it produced.
    expect(lanes[0].bars.map((b) => b.name)).toEqual(["Land Factory", "Mass Extractor"]);
    expect(lanes[1].bars.map((b) => b.name)).toEqual(["Engineer"]);
  });

  it("splits the two air types worth telling apart out of the unit bucket", () => {
    const root = node({
      entityId: "fac",
      category: "factory",
      builds: [
        node({ entityId: "a", category: "unit", name: "Interceptor" }),
        node({ entityId: "b", category: "unit", name: "Bomber" }),
        node({ entityId: "c", category: "unit", name: "Light Assault Bot" }),
      ],
    });
    expect(toLanes(root)[0].bars.map((b) => b.cat)).toEqual(["interceptor", "bomber", "unit"]);
  });
});

describe("markerPaths", () => {
  it("routes a builder through its build sites and snaps them onto resources", () => {
    const env = envelope({
      bo: node({
        entityId: "acu",
        category: "acu",
        x: 0,
        z: 0,
        builds: [
          node({
            entityId: "engie",
            category: "engie",
            name: "Engineer",
            x: 5,
            z: 5,
            builds: [
              // Built a couple of units away from the mass point: close enough
              // to snap, so the line lands on the icon it built.
              node({ entityId: "m1", category: "mex", x: 101, z: 99 }),
              node({ entityId: "s1", category: "structure", x: 150, z: 150 }),
            ],
          }),
        ],
      }),
      markers: [{ type: "Mass", name: "mass1", x: 100, z: 100 }],
      paths: [
        {
          id: "engie",
          name: "Engineer",
          cat: "engie",
          ordinal: 1,
          birth: 0,
          points: [{ t: 0, x: 5, z: 5 }],
        },
      ],
    });

    const [path] = markerPaths(env);
    expect(path.derived).toBe(true);
    // Spawn, the snapped mass point, then the free-placed structure where it
    // was actually put.
    expect(path.points.map((p) => [p.x, p.z])).toEqual([
      [5, 5],
      [100, 100],
      [150, 150],
    ]);
    expect(path.points.every((p) => !p.reclaim)).toBe(true);
  });

  it("splices the recorded sweep back in for reclaim, and only marks the sweep", () => {
    const env = envelope({
      bo: node({
        entityId: "acu",
        category: "acu",
        builds: [
          node({
            entityId: "engie",
            category: "engie",
            name: "Engineer",
            x: 0,
            z: 0,
            builds: [
              node({ entityId: "r1", category: "reclaim", startTime: 10_000, finishTime: 11_000 }),
              node({ entityId: "r2", category: "reclaim", startTime: 12_000, finishTime: 13_000 }),
            ],
          }),
        ],
      }),
      paths: [
        {
          id: "engie",
          name: "Engineer",
          cat: "engie",
          ordinal: 1,
          birth: 0,
          points: [
            { t: 5_000, x: 1, z: 1 },
            { t: 10_500, x: 2, z: 2 },
            { t: 12_500, x: 3, z: 3 },
            { t: 30_000, x: 9, z: 9 },
          ],
        },
      ],
    });

    const [path] = markerPaths(env);
    // Only the samples inside the run's window are spliced in, and both of
    // them sit inside a reclaim action, so both are painted.
    expect(path.points.map((p) => [p.x, p.z, p.reclaim])).toEqual([
      [0, 0, false],
      [2, 2, true],
      [3, 3, true],
    ]);
  });

  it("keeps the raw trail for a unit that never built anything", () => {
    // A tank has no build sites to connect. Collapsing it to a single point
    // would draw nothing at all, which is worse than a wobbly line.
    const env = envelope({
      paths: [
        {
          id: "tank",
          name: "Tank",
          cat: "unit",
          ordinal: 1,
          birth: 0,
          points: [
            { t: 0, x: 1, z: 1 },
            { t: 1_000, x: 2, z: 2 },
          ],
        },
      ],
    });

    const [path] = markerPaths(env);
    expect(path.derived).toBe(false);
    expect(path.points).toHaveLength(2);
  });
});

describe("stallSpans", () => {
  it("reads a stall off storage sitting at zero, and closes an open one", () => {
    const env = envelope({
      eco: {
        fields: ["massStored"],
        labels: {},
        rows: [
          [0, 400],
          [10_000, 0],
          [20_000, 0],
          [30_000, 250],
          [40_000, 0],
        ],
      },
    });

    expect(stallSpans(env, "massStored")).toEqual([
      { from: 10_000, to: 30_000 },
      // Still stalling when the recording stopped, so it is closed there
      // rather than dropped.
      { from: 40_000, to: 60_000 },
    ]);
    expect(stallSpans(env, "notAField")).toEqual([]);
  });
});
