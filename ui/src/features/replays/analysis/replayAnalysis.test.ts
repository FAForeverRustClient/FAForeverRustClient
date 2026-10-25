import { describe, expect, it } from "vitest";

import type { ReplayAnalysis, ReplayPoint } from "../../../ipc/bindings";
import {
  analysedPlayers,
  activitySeries,
  blurBins,
  commandName,
  formatGameTime,
  heatmapBins,
  MAX_ACTIVITY_TICKS,
  MAX_ACTIVITY_SAMPLES,
  MAX_ACTIVITY_TOTAL_SAMPLES,
  ordersInWindow,
  peakOf,
  playerColor,
  rollingActions,
} from "./replayAnalysis";

function point(tick: number, x: number, y: number, source = 0, command = 8): ReplayPoint {
  return { tick, x, y, source, command };
}

describe("the rolling count behind the activity graph", () => {
  it("counts the minute that starts at each tick", () => {
    // Three orders in the first second, nothing after. Every tick of the
    // first minute still sees all three, because the window starts there and
    // reaches forward.
    const { values: series } = rollingActions([0, 5, 9], 600);
    expect(series[0]).toBe(3);
    expect(series[1]).toBe(2);
    expect(series[10]).toBe(0);
  });

  it("drops an order out of the window once the minute has passed it", () => {
    const { values: series } = rollingActions([0, 600], 1_000);
    // The order at tick 600 is a minute away from tick 0, which is the far
    // edge of the window rather than inside it.
    expect(series[0]).toBe(1);
    expect(series[1]).toBe(1);
    expect(series[599]).toBe(1);
  });

  it("allocates by drawing resolution, whatever duration the replay claims", () => {
    const series = rollingActions([0], 4_294_967_295);
    expect(series.values.length).toBeLessThanOrEqual(MAX_ACTIVITY_SAMPLES);
    expect(series.step).toBe(Math.ceil(MAX_ACTIVITY_TICKS / MAX_ACTIVITY_SAMPLES));
    expect(rollingActions([], Number.POSITIVE_INFINITY).values.length).toBe(0);
    expect(rollingActions([], Number.NaN).values.length).toBe(0);
  });

  it("is all zeroes for a player who did nothing", () => {
    expect(peakOf([rollingActions([], 1_000)])).toBe(0);
  });

  it("never reads past the end of the game", () => {
    const { values: series } = rollingActions([90, 100, 105], 100);
    expect(series.length).toBe(100);
    // An order at the final simulation tick is real; one after it is not.
    expect(series[0]).toBe(2);
    expect(series[99]).toBe(1);
  });

  it("matches an independent forward-window count at every sample", () => {
    const commands = [0, 5, 9, 599, 600, 600, 601, 1_100, 5_000, 8_631, 8_999];
    const { values, step } = rollingActions(commands, 9_000);
    for (let i = 0; i < values.length; i += 1) {
      const from = i * step;
      expect(values[i]).toBe(commands.filter((tick) => tick >= from && tick < from + 600).length);
    }
  });

  it("does not wrap high counts at 65,536 actions", () => {
    expect(rollingActions(Array<number>(70_000).fill(0), 100).values[0]).toBe(70_000);
  });

  it("keeps allocation and peak scans bounded over all 255 replay sources", () => {
    const empty = Array.from({ length: 255 }, (_, source) => ({
      source, commandTicks: [] as number[], lastTick: MAX_ACTIVITY_TICKS,
    }));
    const idle = activitySeries(empty, MAX_ACTIVITY_TICKS);
    expect([...idle.values()].reduce((size, entry) => size + entry.values.byteLength, 0)).toBe(0);
    expect(peakOf(idle.values())).toBe(0);

    const active = activitySeries(empty.map((entry) => ({ ...entry, commandTicks: [0] })),
      MAX_ACTIVITY_TICKS);
    const samples = [...active.values()].reduce((size, entry) => size + entry.values.length, 0);
    expect(active.size).toBe(255);
    expect(samples).toBeLessThanOrEqual(MAX_ACTIVITY_TOTAL_SAMPLES);
    expect(peakOf(active.values())).toBe(1);
  });

  it("ignores duplicate and impossible sources without multiplying their series", () => {
    const entry = { source: 0, commandTicks: [0], lastTick: 100 };
    const series = activitySeries([entry, entry, { ...entry, source: -1 },
      { ...entry, source: 256 }, { ...entry, source: 0.5 }], 100);
    expect(series.size).toBe(1);
    expect(series.get(0)?.values[0]).toBe(1);
  });
});

describe("the players table", () => {
  const analysis = {
    uid: 1,
    key: "uid:1",
    ticks: 12_000,
    gameVersion: "",
    armies: [
      {
        source: 0,
        name: "Vindex",
        armyName: "ARMY_1",
        faction: 1,
        color: 12,
        team: 2,
        startSpot: 1,
        human: true,
        country: "de",
        clan: "",
        rating: 1_842,
      },
      {
        source: 1,
        name: "Nuggets",
        armyName: "ARMY_2",
        faction: 3,
        color: 1,
        team: 3,
        startSpot: 2,
        human: true,
        country: "",
        clan: "",
        rating: null,
      },
    ],
    observers: [],
    scenario: { name: "", description: "", mapFolder: "", width: 512, height: 512, options: [] },
    activity: [
      { source: 0, commandTicks: [0, 300, 600], lastTick: 600 },
      { source: 1, commandTicks: [10], lastTick: 12_000 },
    ],
    orders: [],
    points: [],
    notices: [],
    stats: [],
  } satisfies ReplayAnalysis;

  it("divides by the player's own last action, not by the game", () => {
    const [vindex] = analysedPlayers(analysis);
    // Three orders in the first minute of play.
    expect(vindex.perMinute).toBeCloseTo(3, 5);
  });

  it("measures a player who played on over the whole game", () => {
    const nuggets = analysedPlayers(analysis)[1];
    expect(nuggets.perMinute).toBeCloseTo(1 / 20, 5);
  });

  it("gives every player the colour they had on the map", () => {
    expect(analysedPlayers(analysis)[0].color).toBe(playerColor(12));
  });
});

describe("binning the points of a replay", () => {
  it("puts a corner order in a corner cell", () => {
    // The top left of the map is the top left of the picture: world x and z
    // go straight onto image x and y, the way FAF's own previews place a
    // start spot.
    const bins = heatmapBins([point(0, 0, 0)], 512, 512, 8, () => true);
    expect(bins.cells[0]).toBe(1);
    expect(bins.peak).toBe(1);
  });

  it("clamps an order aimed off the edge of the map", () => {
    const bins = heatmapBins([point(0, -80, 9_000)], 512, 512, 8, () => true);
    expect(bins.peak).toBe(1);
    expect([...bins.cells].reduce((sum, value) => sum + value, 0)).toBe(1);
  });

  it("counts only what the filter lets through", () => {
    const points = [point(0, 10, 10, 0), point(50, 10, 10, 1)];
    const mine = heatmapBins(points, 512, 512, 8, (entry) => entry.source === 0);
    expect(mine.peak).toBe(1);
  });

  it("spreads a single point over its neighbours once blurred", () => {
    const sharp = heatmapBins([point(0, 256, 256)], 512, 512, 16, () => true);
    const soft = blurBins(sharp, 2);
    const filled = [...soft.cells].filter((value) => value > 0).length;
    expect(filled).toBeGreaterThan(1);
    expect(soft.peak).toBeLessThan(sharp.peak);
  });
});

describe("the orders under the graph", () => {
  const orders = [
    { source: 0, tick: 10, command: 8, blueprint: "uel0105", detail: "" },
    { source: 0, tick: 700, command: 2, blueprint: "", detail: "" },
    { source: 1, tick: 20, command: 2, blueprint: "", detail: "" },
  ];

  it("keeps the minute that starts where the pointer is", () => {
    const grouped = ordersInWindow(orders, 0);
    expect(grouped.get(0)).toHaveLength(1);
    expect(grouped.get(1)).toHaveLength(1);
  });

  it("has nothing for a minute nobody played in", () => {
    expect(ordersInWindow(orders, 5_000).size).toBe(0);
  });

  it("counts one click onto a group of units once, the way the line does", () => {
    // The stream writes a record per selected unit. Counting them raw put a
    // number under the graph that the graph's own axis never reached.
    const clicked = [
      { source: 0, tick: 10, command: 2, blueprint: "", detail: "" },
      { source: 0, tick: 10, command: 2, blueprint: "", detail: "" },
      { source: 0, tick: 10, command: 2, blueprint: "", detail: "" },
    ];
    expect(ordersInWindow(clicked, 0).get(0)).toHaveLength(1);
  });

  it("keeps two players who gave the same order on the same tick", () => {
    const together = [
      { source: 0, tick: 10, command: 2, blueprint: "", detail: "" },
      { source: 1, tick: 10, command: 2, blueprint: "", detail: "" },
    ];
    const grouped = ordersInWindow(together, 0);
    expect(grouped.get(0)).toHaveLength(1);
    expect(grouped.get(1)).toHaveLength(1);
  });

  it("judges the first order of a window against the one before it", () => {
    // The run is tracked across the whole stream, not restarted where the
    // pointer happens to be: otherwise the same order counted once at one
    // pointer position and twice at the next.
    const repeated = [
      { source: 0, tick: 600, command: 2, blueprint: "", detail: "" },
      { source: 0, tick: 600, command: 2, blueprint: "", detail: "" },
    ];
    expect(ordersInWindow(repeated, 600).get(0)).toHaveLength(1);
  });
});

describe("naming things", () => {
  it("names a command by its number", () => {
    expect(commandName(8)).toBe("Build mobile");
    expect(commandName(2)).toBe("Move");
  });

  it("admits when a number is not one it knows", () => {
    expect(commandName(99)).toBe("Command 99");
  });

  it("stamps game time from ticks", () => {
    expect(formatGameTime(0)).toBe("00:00");
    expect(formatGameTime(6_000)).toBe("10:00");
    expect(formatGameTime(36_000 + 6_000 + 50)).toBe("1:10:05");
  });
});

it("does not overwrite raw heatmap bins when smoothing changes", () => {
  const cells = new Float32Array([0, 0, 0, 0, 9, 0, 0, 0, 0]);
  const raw = { cells, size: 3, peak: 9 };
  const first = blurBins(raw, 1);
  blurBins(raw, 2);
  expect([...raw.cells]).toEqual([0, 0, 0, 0, 9, 0, 0, 0, 0]);
  expect([...blurBins(raw, 1).cells]).toEqual([...first.cells]);
});
