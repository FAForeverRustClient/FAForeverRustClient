// The Overview's own rules, pinned to the website's `drawOverview`,
// `stopAtRemaining`, `roundLabel` and `mapsFor`.

import { describe, expect, it } from "vitest";
import {
  aliveCount,
  recentResults,
  resultRoundLabel,
  roundMapNames,
  stopAtRemaining,
} from "./overviewPresentation";
import { richParts } from "./richParts";
import { match, team, tourney } from "./fixtures";

const t = (key: string, values?: Record<string, string | number>) =>
  values === undefined ? key : `${key}${JSON.stringify(values)}`;

describe("stopAtRemaining", () => {
  const teams = [
    team({ id: "a" }),
    team({ id: "b" }),
    team({ id: "c" }),
    team({ id: "d", eliminated: true }),
    team({ id: "e", eliminated: true }),
  ];

  it("counts the eliminations left before the stop, from the teams still in", () => {
    const event = tourney({ status: "running", stopAtAlive: 2, teams });
    expect(aliveCount(event)).toBe(3);
    expect(stopAtRemaining(event)).toBe(1);
  });

  it("never goes below zero, which is the last result ending it", () => {
    expect(stopAtRemaining(tourney({ status: "running", stopAtAlive: 4, teams }))).toBe(0);
  });

  it("is nothing without a stop or outside a running event", () => {
    expect(stopAtRemaining(tourney({ status: "running", stopAtAlive: 0, teams }))).toBeNull();
    expect(stopAtRemaining(tourney({ status: "signup", stopAtAlive: 2, teams }))).toBeNull();
    expect(stopAtRemaining(tourney({ status: "finished", stopAtAlive: 2, teams }))).toBeNull();
  });
});

describe("recentResults", () => {
  it("keeps the eight latest done matches, newest round first, free-for-all included", () => {
    const matches = [
      ...Array.from({ length: 6 }, (_, index) =>
        match({ id: `r1-${index}`, round: 1, index, status: "done" }),
      ),
      match({ id: "r2-1", round: 2, index: 1, status: "done" }),
      match({ id: "r2-0", round: 2, index: 0, status: "done" }),
      match({ id: "ffa", bracket: "freeForAll", round: 3, index: 0, status: "done" }),
      match({ id: "open", round: 3, index: 1, status: "ready" }),
    ];
    const ids = recentResults(tourney({ matches })).map((entry) => entry.id);
    expect(ids).toEqual(["ffa", "r2-0", "r2-1", "r1-0", "r1-1", "r1-2", "r1-3", "r1-4"]);
  });
});

describe("resultRoundLabel", () => {
  const winners = [1, 2, 3, 4].map((round) => match({ id: `w${round}`, round }));

  it("names the deepest winners rounds, and numbers the rest", () => {
    const event = tourney({ bracketKind: "single", matches: winners });
    expect(winners.map((entry) => resultRoundLabel(event, entry, t))).toEqual([
      'tournaments.recent.round{"round":1}',
      "tournaments.recent.quarters",
      "tournaments.recent.semis",
      "tournaments.recent.final",
    ]);
  });

  it("puts the winners bracket in front on a double elimination", () => {
    const event = tourney({ bracketKind: "double", matches: winners });
    expect(resultRoundLabel(event, winners[3], t)).toBe(
      'tournaments.recent.winners{"label":"tournaments.recent.final"}',
    );
    expect(resultRoundLabel(event, match({ bracket: "losers", round: 2 }), t)).toBe(
      'tournaments.recent.losersRound{"round":2}',
    );
  });

  it("calls a Swiss event's closing match the final, not the grand final", () => {
    const final = match({ bracket: "grandFinal", round: 5 });
    expect(resultRoundLabel(tourney({ bracketKind: "swiss" }), final, t)).toBe("tournaments.recent.final");
    expect(resultRoundLabel(tourney({ bracketKind: "double" }), final, t)).toBe(
      "tournaments.recent.grandFinal",
    );
  });

  it("calls a lone last free-for-all lobby the final, from round two on", () => {
    const lobbies = [
      match({ id: "a", bracket: "freeForAll", round: 1 }),
      match({ id: "b", bracket: "freeForAll", round: 1, index: 1 }),
      match({ id: "c", bracket: "freeForAll", round: 2 }),
    ];
    const event = tourney({ competition: "freeForAll", matches: lobbies });
    expect(resultRoundLabel(event, lobbies[2], t)).toBe("tournaments.recent.final");
    expect(resultRoundLabel(event, lobbies[0], t)).toBe('tournaments.recent.round{"round":1}');
  });
});

describe("roundMapNames", () => {
  const mapDb = [
    { id: "m1", name: "Seton's Clutch", imageUrl: "", description: "", published: true, spec: null, secret: false, masked: false },
  ];

  it("names a round's maps from the database, and an unknown one by its id", () => {
    const event = tourney({ mapDb, roundMaps: [{ round: "wb:2", mapIds: ["m1", "x9"] }] });
    expect(roundMapNames(event, match({ round: 2 }))).toEqual(["Seton's Clutch", "x9"]);
  });

  it("plays a 3rd place match without maps of its own on the semi-finals' maps", () => {
    const event = tourney({ mapDb, roundMaps: [{ round: "wb:2", mapIds: ["m1"] }] });
    expect(roundMapNames(event, match({ bracket: "thirdPlace", round: 3 }))).toEqual(["Seton's Clutch"]);
  });
});

describe("richParts", () => {
  it("splits a sentence into its plain, bold and link parts", () => {
    expect(richParts("Uses your **Global** rating, see [here].")).toEqual([
      { kind: "text", text: "Uses your " },
      { kind: "strong", text: "Global" },
      { kind: "text", text: " rating, see " },
      { kind: "link", text: "here" },
      { kind: "text", text: "." },
    ]);
  });

  it("leaves a sentence without marks whole", () => {
    expect(richParts("No results yet.")).toEqual([{ kind: "text", text: "No results yet." }]);
  });
});
