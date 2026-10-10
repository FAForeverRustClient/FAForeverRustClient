// The Overview's own rules, pinned to the website's `drawOverview`,
// `stopAtRemaining`, `roundLabel` and `mapsFor`.

import { describe, expect, it } from "vitest";
import {
  aliveCount,
  formatCells,
  recentResults,
  resultRoundLabel,
  rewardSplit,
  roundMapNames,
  settingRows,
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

describe("formatCells", () => {
  it("splits a bracket event into who plays, the bracket, and the match length", () => {
    const cells = formatCells(tourney({ teamSize: 1, bracketKind: "single" }), t);
    expect(cells.map((cell) => [cell.label, cell.value])).toEqual([
      ["tournaments.overview.format", "1v1"],
      ["tournaments.section.bracket", "tournaments.overview.singleElim"],
    ]);
  });
});

describe("settingRows", () => {
  it("reads one setting per line, with or without a bullet", () => {
    expect(settingRows("- Game Type: FAF\nVictory Conditions: Assassination\n\n**Teams:** Locked")).toEqual({
      rows: [
        { key: "Game Type", value: "FAF" },
        { key: "Victory Conditions", value: "Assassination" },
        { key: "Teams", value: "Locked" },
      ],
      before: "",
      after: "",
    });
  });

  it("keeps the value's own colons and emphasis", () => {
    expect(settingRows("Title: CC3 - Round X: Game X\nMods: *UI mods only*")?.rows).toEqual([
      { key: "Title", value: "CC3 - Round X: Game X" },
      { key: "Mods", value: "*UI mods only*" },
    ]);
  });

  it("keeps the notes over and under the list, as the official events close theirs", () => {
    const list = settingRows("Set these:\n- Game Type: FAF\n- Unrate: No\n*All other settings at default.*");
    expect(list?.before).toBe("Set these:");
    expect(list?.rows).toHaveLength(2);
    expect(list?.after).toBe("*All other settings at default.*");
  });

  it("gives up on prose between settings, and on a list of one", () => {
    expect(settingRows("Game Type: FAF\nPlease be on time.\nUnrate: No")).toBeNull();
    expect(settingRows("Game Type: FAF")).toBeNull();
    expect(settingRows("See https://example.com")).toBeNull();
    expect(settingRows("")).toBeNull();
  });
});

describe("rewardSplit", () => {
  it("reads one placement per line, with the cash taken out of the rest", () => {
    const split = rewardSplit(
      ["## Prizes", "**1st:** $250 + Winner avatar", "**2nd:** $150 + Faction Face Avatar", "3rd: Faction Logo Avatar"].join(
        "\n",
      ),
      "$400",
    );
    expect(split.places).toEqual([
      { place: 1, top: false, cash: "$250", rest: "Winner avatar" },
      { place: 2, top: false, cash: "$150", rest: "Faction Face Avatar" },
      { place: 3, top: false, cash: "", rest: "Faction Logo Avatar" },
    ]);
    expect(split.notes).toBe("");
  });

  it("finds the cash after the prose and through a bold block", () => {
    const split = rewardSplit("**1st - Champion avatar + $160\n2nd - Faction face + $80**", "");
    expect(split.places.map((place) => [place.place, place.cash, place.rest])).toEqual([
      [1, "$160", "Champion avatar"],
      [2, "$80", "Faction face"],
    ]);
  });

  it("keeps a Top N group and lines that are not placements", () => {
    const split = rewardSplit("Top 4 qualify to the finals\n8 players minimum", "");
    expect(split.places).toEqual([{ place: 4, top: true, cash: "", rest: "qualify to the finals" }]);
    expect(split.notes).toBe("8 players minimum");
  });

  it("gives the whole total to first when the winner takes it all", () => {
    const split = rewardSplit("The winner takes it all, and will also get an avatar.", "$75");
    expect(split.places).toEqual([{ place: 1, top: false, cash: "$75", rest: "" }]);
    expect(split.notes).toBe("The winner takes it all, and will also get an avatar.");
  });

  it("leaves text without a split as notes", () => {
    expect(rewardSplit("Avatars for the winners", "$150")).toEqual({ places: [], notes: "Avatars for the winners" });
  });
});
