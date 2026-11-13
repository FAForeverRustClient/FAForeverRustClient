import { describe, expect, it } from "vitest";
import type { PlayerActivityMonth } from "../../ipc/bindings";
import {
  activityQueue,
  activityQueueColor,
  busiestMonth,
  daysBetween,
  hourStep,
  localWeek,
  monthBars,
  queuesIn,
  yearBars,
} from "./playerActivity";

const month = (period: string, queues: Array<[string, number]>, games = queues.length): PlayerActivityMonth => ({
  period,
  games,
  minutes: queues.reduce((sum, [, minutes]) => sum + minutes, 0),
  queues: queues.map(([queue, minutes]) => ({ queue, minutes })),
});

describe("the Activity figures (issue 748)", () => {
  it("keeps a queue's colour whatever else was played", () => {
    expect(activityQueueColor("global")).toBe("var(--color-chart-1)");
    expect(activityQueueColor("tmm_3v3")).toBe("var(--color-chart-4)");
    expect(activityQueue("coop")).toBe("other");
    expect(activityQueueColor("other")).toBe("var(--color-chart-7)");
  });

  it("orders a bar's queues by colour, folding unknown ones into other", () => {
    const [bar] = monthBars([month("2026-01", [["coop", 10], ["ladder_1v1", 30], ["global", 20], ["custom", 5]])]);
    expect(bar.queues).toEqual([
      { queue: "global", minutes: 20 },
      { queue: "ladder_1v1", minutes: 30 },
      { queue: "other", minutes: 15 },
    ]);
  });

  it("shows the last months, or one bar per year", () => {
    const months = [
      month("2025-11", [["global", 60]]),
      month("2025-12", [], 0),
      month("2026-01", [["tmm_2v2", 30]]),
    ];
    expect(monthBars(months, 2).map((bar) => bar.period)).toEqual(["2025-12", "2026-01"]);
    const years = yearBars(months);
    expect(years.map((bar) => [bar.period, bar.minutes, bar.games])).toEqual([["2025", 60, 1], ["2026", 30, 1]]);
    expect(queuesIn(years)).toEqual(["global", "tmm_2v2"]);
  });

  it("finds the busiest month, the earlier of a tie", () => {
    const months = [month("2026-01", [["global", 30]]), month("2026-02", [["global", 30]]), month("2026-03", [], 0)];
    expect(busiestMonth(months)?.period).toBe("2026-01");
    expect(busiestMonth([month("2026-03", [], 0)])).toBeNull();
  });

  it("moves the UTC week into the reader's time zone", () => {
    const utc = new Array<number>(168).fill(0);
    utc[0] = 10; // Monday 00:00 UTC
    utc[167] = 5; // Sunday 23:00 UTC
    const berlin = localWeek(utc, 60);
    expect(berlin[1]).toBe(10);
    expect(berlin[0]).toBe(5); // Sunday 23:00 UTC is Monday 00:00 in Berlin
    const newYork = localWeek(utc, -300);
    expect(newYork[163]).toBe(10); // Sunday 19:00
    expect(localWeek([], 60)).toHaveLength(168);
  });

  it("picks a round gridline step", () => {
    expect(hourStep(0)).toBe(1);
    expect(hourStep(7)).toBe(2);
    expect(hourStep(37)).toBe(10);
    expect(hourStep(180)).toBe(50);
  });

  it("counts whole days between two dates", () => {
    expect(daysBetween("2026-01-01T00:00:00Z", "2026-01-10T12:00:00Z")).toBe(9);
    expect(daysBetween("", "2026-01-10T12:00:00Z")).toBeNull();
  });
});
