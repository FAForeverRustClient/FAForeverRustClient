import { describe, expect, it } from "vitest";

import type { ReplayPlayer, ReplayTeam } from "../../../ipc/bindings";
import { activityRows, chatSenders, formatChatTime, isTransferMessage } from "./ReplayInsights";

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

describe("who wrote in the chat", () => {
  const line = (sender: string) => ({ sender, message: "gg", timeSeconds: 0, to: "all" });

  it("lists each sender once with their line count, alphabetically whatever the case", () => {
    const senders = chatSenders([line("Sainse"), line("rewer"), line("Sainse"), line("Nory")]);
    expect(senders).toEqual([
      { name: "Nory", lines: 1 },
      { name: "rewer", lines: 1 },
      { name: "Sainse", lines: 2 },
    ]);
  });

  it("counts only what the other filters leave, and keeps a name they leave nothing of", () => {
    const all = [line("Sainse"), line("Sainse"), line("Nory")];
    const left = [all[0]];
    expect(chatSenders(all, left)).toEqual([
      { name: "Nory", lines: 0 },
      { name: "Sainse", lines: 1 },
    ]);
  });
});

describe("telling transfers from talk", () => {
  it("recognises the lines the game writes when someone shares or asks", () => {
    for (const line of [
      "Sent 1.5k energy to Rewer",
      "Sent 4.5k Energy to Rewer",
      "Sent 252 energy to GMULO",
      "Sent 300 mass to Nory",
      "sent 1 unit to Seraphim-Noob",
      "Sent 12 units to Nory",
      "Can you give me some energy, WhocaresbruhXD?",
      "Can you give me some mass, Sainse?",
    ]) {
      expect(isTransferMessage(line), line).toBe(true);
    }
  });

  it("leaves what people typed alone, even about energy", () => {
    for (const line of ["gg", "sent it to mid", "need energy", "can you give me some time", "Paused the game"]) {
      expect(isTransferMessage(line), line).toBe(false);
    }
  });
});

describe("stamping a line of replay chat", () => {
  it("counts hours, and pads the minutes and seconds", () => {
    expect(formatChatTime(0)).toBe("0:00:00");
    expect(formatChatTime(65)).toBe("0:01:05");
    expect(formatChatTime(3725)).toBe("1:02:05");
  });
});
