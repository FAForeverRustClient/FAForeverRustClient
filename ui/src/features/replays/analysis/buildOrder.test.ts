import { describe, expect, it } from "vitest";
import type { ReplayOrder, ReplayQueueChange, UnitSummary } from "../../../ipc/bindings";
import {
  buildEntries,
  buildRows,
  defaultPair,
  enhancementWords,
  milestoneTicks,
  unitCatalogue,
  unitsPerMinute,
} from "./buildOrder";

function unit(id: string, overrides: Partial<UnitSummary>): UnitSummary {
  return {
    id,
    path: `units/${id}/${id}_unit.bp`,
    iconUrl: "",
    name: null,
    description: null,
    faction: "UEF",
    tech: 1,
    kind: "land",
    strategicIcon: null,
    role: null,
    ...overrides,
  };
}

const catalogue = unitCatalogue([
  unit("UEB0101", { kind: "structure", role: "landFactory" }),
  unit("UEB0102", { kind: "structure", role: "airFactory" }),
  unit("UEB1102", { kind: "structure", role: "hydrocarbon" }),
  unit("UEB1103", { kind: "structure", role: "massExtractor" }),
  unit("UEB1202", { kind: "structure", role: "massExtractor", tech: 2 }),
  unit("UEB0201", { kind: "structure", role: "landFactory", tech: 2 }),
  unit("UEL0105", { description: "Engineer" }),
  unit("UEL0201", { name: "MA12 Striker", description: "Medium Tank" }),
  unit("UEL0202", { name: "Pillar", tech: 2 }),
  unit("UEL0401", { name: "Fatboy", tech: 4 }),
]);

function order(tick: number, command: number, blueprint: string, extra: Partial<ReplayOrder> = {}): ReplayOrder {
  return { source: 0, tick, command, blueprint, enhancement: "", units: 1, ...extra };
}

function change(tick: number, blueprint: string, delta: number): ReplayQueueChange {
  return { source: 0, tick, blueprint, delta };
}

describe("the build order", () => {
  it("keeps what builds and drops every other order", () => {
    const entries = buildEntries(
      {
        orders: [
          order(10, 8, "ueb0101"),
          order(12, 2, ""), // a move
          order(20, 7, "uel0105", { units: 3 }), // three factories
          order(30, 28, "", { enhancement: "AdvancedEngineering" }),
          order(31, 28, ""), // a script order that is no upgrade
          order(40, 8, "ueb1103", { source: 1 }), // the other player
        ],
        queueChanges: [change(25, "uel0105", 2)],
      },
      0,
    );
    expect(entries.map((entry) => [entry.tick, entry.unit, entry.enhancement, entry.quantity, entry.queueChange])).toEqual([
      [10, "UEB0101", null, 1, false],
      [20, "UEL0105", null, 3, false],
      [25, "UEL0105", null, 2, true],
      [30, null, "AdvancedEngineering", 1, false],
    ]);
  });

  it("folds equal orders of one tick into one row", () => {
    const entries = buildEntries(
      {
        orders: [order(10, 8, "ueb1103"), order(10, 8, "ueb1103"), order(10, 8, "ueb1102"), order(11, 8, "ueb1103")],
        queueChanges: [],
      },
      0,
    );
    expect(buildRows(entries).map((row) => [row.tick, row.unit, row.repeats, row.quantity])).toEqual([
      [10, "UEB1103", 2, 2],
      [10, "UEB1102", 1, 1],
      [11, "UEB1103", 1, 1],
    ]);
  });

  it("times each milestone by the first order that reaches it", () => {
    const entries = buildEntries(
      {
        orders: [
          order(50, 8, "ueb0101"),
          order(60, 8, "ueb0101"),
          order(900, 27, "ueb1202"), // a mass extractor upgraded
          order(1200, 28, "", { enhancement: "T3EngineeringRemove" }), // a removal is no upgrade
          order(1300, 28, "", { enhancement: "AdvancedEngineering" }),
          order(1500, 7, "uel0202"),
          order(3000, 8, "uel0401"),
        ],
        queueChanges: [],
      },
      0,
    );
    const ticks = milestoneTicks(entries, catalogue);
    expect(ticks.landFactory).toBe(50);
    expect(ticks.airFactory).toBeNull();
    expect(ticks.massUpgrade).toBe(900);
    expect(ticks.acuUpgrade).toBe(1300);
    expect(ticks.t2Unit).toBe(1500);
    expect(ticks.t2Factory).toBeNull();
    expect(ticks.experimental).toBe(3000);
  });

  it("counts the mobile units ordered per minute, queue changes included", () => {
    const entries = buildEntries(
      {
        orders: [
          order(100, 7, "uel0105", { units: 2 }),
          order(200, 8, "ueb0101"), // a structure, not counted
          order(700, 7, "uel0201", { units: 1 }),
        ],
        queueChanges: [change(150, "uel0105", 3), change(710, "uel0201", -1)],
      },
      0,
    );
    const minutes = unitsPerMinute(entries, catalogue, 3);
    expect(minutes[0]).toEqual([{ unit: "UEL0105", count: 5 }]);
    // Ordered and taken back in the same minute: nothing left to show.
    expect(minutes[1]).toEqual([]);
    expect(minutes[2]).toEqual([]);
  });

  it("writes an enhancement as words", () => {
    expect(enhancementWords("AdvancedEngineering")).toBe("Advanced Engineering");
    expect(enhancementWords("T3EngineeringRemove")).toBe("T3 Engineering");
    expect(enhancementWords("FAF_SelfRepairSystem")).toBe("Self Repair System");
  });

  it("compares the first players of two teams by default", () => {
    expect(
      defaultPair([
        { source: 0, team: 2 },
        { source: 1, team: 2 },
        { source: 2, team: 3 },
      ]),
    ).toEqual([0, 2]);
    expect(defaultPair([{ source: 0, team: 1 }, { source: 1, team: 1 }])).toEqual([0, 1]);
    expect(defaultPair([{ source: 0, team: 1 }])).toBeNull();
  });
});
