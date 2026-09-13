import { describe, expect, it } from "vitest";

import type { ReplayPlayer, ReplayTeam } from "../../ipc/bindings";
import { activityRows, formatChatTime } from "./ReplayInsights";

function player(name: string, extra: Partial<ReplayPlayer> = {}): ReplayPlayer {
  return {
    name,
    faction: 1,
    rating: 1500,
    ratingChange: null,
    outcome: "",
    score: null,
    ...extra,
  };
}

function team(number: number, ...players: ReplayPlayer[]): ReplayTeam {
  return { team: number, players };
}

describe("joining command counts to the lineup", () => {
  const teams = [team(2, player("Vindex")), team(3, player("Nuggets", { rating: 2100 }))];

  it("turns a count and a game length into a rate", () => {
    const rows = activityRows([{ player: "Vindex", commands: 600 }], teams, 600);
    expect(rows[0].perMinute).toBeCloseTo(60, 5);
  });

  it("says nothing rather than dividing by a game with no length", () => {
    // A replay whose stream could not be walked has no ticks in it, and
    // "Infinity commands per minute" is not an answer.
    const rows = activityRows([{ player: "Vindex", commands: 12 }], teams, 0);
    expect(rows[0].perMinute).toBeNull();
  });

  it("matches a login whatever case the two sides spell it in", () => {
    const rows = activityRows([{ player: "nuggets", commands: 10 }], teams, 60);
    expect(rows[0].rating).toBe(2100);
    expect(rows[0].team).toBe(3);
  });

  it("keeps somebody the lineup never listed", () => {
    // An observer is in the replay file's client table and in no team, and
    // who was watching is worth seeing.
    const rows = activityRows([{ player: "Watcher", commands: 3 }], teams, 60);
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBeNull();
    expect(rows[0].team).toBeNull();
  });

  it("puts the busiest player first", () => {
    const rows = activityRows(
      [
        { player: "Vindex", commands: 100 },
        { player: "Nuggets", commands: 400 },
      ],
      teams,
      60,
    );
    expect(rows.map((row) => row.player)).toEqual(["Nuggets", "Vindex"]);
  });
});

describe("stamping a line of replay chat", () => {
  it("counts hours, and pads the minutes and seconds", () => {
    expect(formatChatTime(0)).toBe("0:00:00");
    expect(formatChatTime(65)).toBe("0:01:05");
    expect(formatChatTime(3725)).toBe("1:02:05");
  });
});
