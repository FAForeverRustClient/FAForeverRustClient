import { describe, expect, it } from "vitest";

import type { ReplayAnalysis, ReplayPoint } from "../../ipc/bindings";
import {
  analysedPlayers,
  blurBins,
  commandName,
  formatGameTime,
  heatmapBins,
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
    const series = rollingActions([0, 5, 9], 1_200);
    expect(series[0]).toBe(3);
    expect(series[1]).toBe(2);
    expect(series[10]).toBe(0);
  });

  it("drops an order out of the window once the minute has passed it", () => {
    const series = rollingActions([0, 600], 1_200);
    // The order at tick 600 is a minute away from tick 0, which is the far
    // edge of the window rather than inside it.
    expect(series[0]).toBe(1);
    expect(series[1]).toBe(1);
    expect(series[599]).toBe(1);
  });

  it("is all zeroes for a player who did nothing", () => {
    expect(peakOf([rollingActions([], 1_000)])).toBe(0);
  });

  it("never reads past the end of the game", () => {
    const series = rollingActions([90], 100);
    expect(series.length).toBe(100);
    expect(series[0]).toBe(1);
  });
});

describe("the players table", () => {
  const analysis = {
    uid: 1,
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
