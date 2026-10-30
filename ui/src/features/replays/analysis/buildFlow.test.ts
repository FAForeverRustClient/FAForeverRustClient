import { describe, expect, it } from "vitest";
import type { ReplayOrder, ReplayQueueChange, UnitSummary } from "../../../ipc/bindings";
import { unitCatalogue } from "./buildOrder";
import { buildFlow, categoryOf, flowSpan, UPGRADES_LANE } from "./buildFlow";

function unit(id: string, overrides: Partial<UnitSummary>): UnitSummary {
  return {
    id,
    path: "",
    iconUrl: "",
    name: null,
    description: null,
    faction: "UEF",
    tech: 1,
    kind: "land",
    strategicIcon: null,
    sortPriority: 10,
    role: null,
    buildTime: null,
    buildRate: null,
    ...overrides,
  };
}

const catalogue = unitCatalogue([
  unit("UEL0001", { tech: null, buildRate: 10 }),
  unit("UEL0105", { description: "Engineer", strategicIcon: "icon_land1_engineer", buildTime: 260, buildRate: 5 }),
  unit("UEL0201", { name: "MA12 Striker", strategicIcon: "icon_land1_directfire", buildTime: 120 }),
  unit("UEB0101", { kind: "structure", role: "landFactory", buildTime: 300, buildRate: 20, strategicIcon: "icon_factory1_land" }),
  unit("UEB1103", { kind: "structure", role: "massExtractor", buildTime: 60, strategicIcon: "icon_structure1_mass" }),
  unit("UEB1202", { kind: "structure", role: "massExtractor", tech: 2, buildTime: 900, strategicIcon: "icon_structure2_mass" }),
  unit("UEB1101", { kind: "structure", buildTime: 40, strategicIcon: "icon_structure1_energy" }),
  unit("UEA0103", { kind: "air", description: "Attack Bomber" }),
  unit("UEA0102", { kind: "air", description: "Interceptor" }),
]);

let next = 100;
function order(source: number, tick: number, command: number, blueprint: string, unitNumber: number, extra: Partial<ReplayOrder> = {}): ReplayOrder {
  next += 1;
  return { source, tick, command, blueprint, enhancement: "", units: 1, id: next, unit: unitNumber, ...extra };
}

function cancel(order: ReplayOrder): ReplayQueueChange {
  return { source: order.source, tick: order.tick + 1, blueprint: order.blueprint, delta: -1, order: order.id };
}

describe("the build order lanes", () => {
  // The commander (0) builds a factory (1) and a mex; the factory builds two
  // engineers and a tank; the first engineer (2) builds a power generator.
  const factory = order(0, 100, 8, "ueb0101", 0);
  const mex = order(0, 110, 8, "ueb1103", 0);
  const engineerA = order(0, 500, 7, "uel0105", 1);
  const engineerB = order(0, 510, 7, "uel0105", 1);
  const tank = order(0, 520, 7, "uel0201", 1);
  const cancelledTank = order(0, 530, 7, "uel0201", 1);
  const power = order(0, 1200, 8, "ueb1101", 2);
  const second = order(0, 1300, 8, "ueb1103", 5);
  const upgrade = order(0, 2000, 27, "ueb1202", 3);
  const enhancement = order(0, 2100, 28, "", 0, { enhancement: "AdvancedEngineering" });
  const other = order(1, 100, 8, "ueb0101", 0);
  const analysis = {
    orders: [factory, mex, engineerA, engineerB, tank, cancelledTank, power, second, upgrade, enhancement, other],
    queueChanges: [cancel(cancelledTank)],
  };
  const lanes = buildFlow(analysis, 0, 1, catalogue);

  it("gives every builder a lane, the commander first", () => {
    expect(lanes.map((lane) => [lane.kind, lane.id, lane.unit, lane.index])).toEqual([
      ["acu", 0, 0, 0],
      ["factory", 1, 1, 1],
      ["engineer", 2, 2, 1],
      ["engineer", 3, 5, 2],
      ["upgrades", UPGRADES_LANE, UPGRADES_LANE, 0],
    ]);
    expect(lanes[1].layer).toBe("land");
  });

  it("runs a lane's builds one after the other at the builder's build power", () => {
    const [acu, factoryLane] = lanes;
    // 300 build time at 10 power: 30 s, 300 ticks. The mex waits for it.
    expect([acu.nodes[0].start, acu.nodes[0].end]).toEqual([100, 400]);
    expect([acu.nodes[1].start, acu.nodes[1].end]).toEqual([400, 460]);
    // Engineers at the factory's 20: 13 s each, one after the other.
    expect(factoryLane.nodes.map((node) => [node.start, node.end])).toEqual([
      [500, 630],
      [630, 760],
      [760, 820],
      [530, 530],
    ]);
  });

  it("marks an order taken off the queue, and lets it take no time", () => {
    const cancelled = lanes[1].nodes[3];
    expect(cancelled.cancelled).toBe(true);
    expect(lanes[1].nodes[2].cancelled).toBe(false);
  });

  it("joins a build to the builder it became, in the order builders first built", () => {
    const [acu, factoryLane] = lanes;
    expect(acu.nodes[0].child).toBe(1);
    expect(factoryLane.nodes[0].child).toBe(2);
    expect(factoryLane.nodes[1].child).toBe(3);
    expect(factoryLane.nodes[2].child).toBeNull();
  });

  it("keeps a commander upgrade on the commander's lane without a length", () => {
    const node = lanes[0].nodes.find((candidate) => candidate.enhancement);
    expect(node?.enhancement).toBe("AdvancedEngineering");
    expect(node?.end).toBeNull();
    expect(node?.category).toBe("acu");
  });

  it("puts a mass extractor's upgrade on the shared upgrades lane", () => {
    expect(lanes[4].nodes.map((node) => node.unit)).toEqual(["UEB1202"]);
    expect(flowSpan(lanes, 0)).toBeGreaterThan(2000);
  });

  it("starts a new lane where the engine gave a gone unit's number to another", () => {
    // Replay 28032260: unit 3 is a mass extractor upgraded at 1:15 and an
    // air factory from 5:11; unit 2 an engineer, then a factory.
    const reused = buildFlow(
      {
        orders: [
          order(0, 40, 8, "ueb0101", 0),
          order(0, 300, 8, "ueb1103", 2),
          order(0, 755, 27, "ueb1202", 3),
          order(0, 3119, 7, "uel0201", 3),
          order(0, 3200, 7, "uel0201", 2),
          order(0, 3300, 8, "ueb1101", 3),
        ],
        queueChanges: [],
      },
      0,
      1,
      catalogue,
    );
    expect(reused.map((lane) => [lane.kind, lane.unit, lane.nodes.map((node) => node.unit)])).toEqual([
      ["acu", 0, ["UEB0101"]],
      ["engineer", 2, ["UEB1103"]],
      ["factory", 3, ["UEL0201"]],
      ["factory", 2, ["UEL0201"]],
      ["engineer", 3, ["UEB1101"]],
      ["upgrades", UPGRADES_LANE, ["UEB1202"]],
    ]);
  });

  it("takes a queue change to the latest order of its id, which the engine reuses", () => {
    const first = order(0, 500, 7, "uel0201", 1, { id: 7 });
    const again = order(0, 900, 7, "uel0201", 1, { id: 7 });
    const [, factoryLane] = buildFlow({ orders: [order(0, 40, 8, "ueb0101", 0), first, again], queueChanges: [cancel(again)] }, 0, 1, catalogue);
    expect(factoryLane.nodes.map((node) => node.cancelled)).toEqual([false, true]);
  });

  it("sorts units into the analyser's colours", () => {
    expect(categoryOf(catalogue.get("UEB0101"))).toBe("factory");
    expect(categoryOf(catalogue.get("UEB1103"))).toBe("mex");
    expect(categoryOf(catalogue.get("UEB1101"))).toBe("power");
    expect(categoryOf(catalogue.get("UEL0105"))).toBe("engie");
    expect(categoryOf(catalogue.get("UEA0103"))).toBe("bomber");
    expect(categoryOf(catalogue.get("UEA0102"))).toBe("interceptor");
    expect(categoryOf(catalogue.get("UEL0201"))).toBe("unit");
    expect(categoryOf(undefined)).toBe("unit");
  });
});
