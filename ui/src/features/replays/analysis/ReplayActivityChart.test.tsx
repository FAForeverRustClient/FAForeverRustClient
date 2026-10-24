import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ReplayAnalysis } from "../../../ipc/bindings";
import { ReplayActivityChart } from "./ReplayActivityChart";
import { MAX_ACTIVITY_TICKS, MAX_ACTIVITY_TOTAL_SAMPLES } from "./replayAnalysis";

function replay(active: boolean, duplicateSources = false): ReplayAnalysis {
  const armies = Array.from({ length: 255 }, (_, i) => ({
    source: duplicateSources ? 0 : i, name: `Player ${i}`, armyName: `ARMY_${i}`,
    faction: 1, color: 1, team: 2, startSpot: i, human: true,
    country: "", clan: "", rating: null,
  }));
  return {
    uid: 1, key: "uid:1", ticks: MAX_ACTIVITY_TICKS, gameVersion: "",
    armies, observers: [],
    scenario: { name: "", description: "", mapFolder: "", width: 512, height: 512, options: [] },
    activity: armies.map(({ source }) => ({
      source, commandTicks: active ? [0] : [], lastTick: MAX_ACTIVITY_TICKS,
    })),
    orders: [], points: [], notices: [], stats: [],
  };
}

function lines(markup: string): string[] {
  return markup.match(/<path class="replay-chart-line"[^>]*>/g) ?? [];
}

describe("the activity chart's complete output budget", () => {
  it("renders an idle day-long replay with 255 sources as an empty state", () => {
    const markup = renderToStaticMarkup(<ReplayActivityChart analysis={replay(false)} />);
    expect(markup).toContain("replay-detail-empty");
    expect(lines(markup)).toHaveLength(0);
  });

  it("keeps every active source within the shared SVG sample budget", () => {
    const markup = renderToStaticMarkup(<ReplayActivityChart analysis={replay(true)} />);
    const paths = lines(markup);
    expect(paths).toHaveLength(255);
    const samples = paths.reduce((count, path) => count + (path.match(/[ML]/g)?.length ?? 0), 0);
    expect(samples).toBeLessThanOrEqual(MAX_ACTIVITY_TOTAL_SAMPLES);
    expect(markup).not.toMatch(/NaN|Infinity/);
  });

  it("draws each source once even when army headers repeat it", () => {
    const markup = renderToStaticMarkup(<ReplayActivityChart analysis={replay(true, true)} />);
    expect(lines(markup)).toHaveLength(1);
  });

  it("keeps separate AI armies in the legend when they have no command source", () => {
    const analysis = replay(true);
    analysis.armies[0].source = -1;
    analysis.armies[1].source = -1;
    const markup = renderToStaticMarkup(<ReplayActivityChart analysis={analysis} />);
    expect(markup).toContain(">Player 0<");
    expect(markup).toContain(">Player 1<");
    expect(lines(markup)).toHaveLength(253);
  });
});
