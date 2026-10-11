// Where an event is at a glance: the website's own rules for the status pill,
// the stage stepper, the list row and the "your turn" banner.
//
// Presentation, so no conformance twin. What is pinned are the cases the
// website itself spells out: the pill that must not say "Signups open" before
// they are, the day runs that carry only as much month and year as they need,
// the countdown precedence, and the banner's order.

import { describe, expect, it } from "vitest";
import {
  archiveByYear,
  eventDaysLabel,
  listCountdowns,
  listKind,
  stages,
  statusPill,
  turnInfo,
} from "./orientation";
import { match, player, team, tourney } from "./fixtures";

const t = (key: string, values?: Record<string, string | number>) =>
  values === undefined ? key : `${key}${JSON.stringify(values)}`;

describe("statusPill", () => {
  it("says signups are not open yet while the opening is ahead", () => {
    const event = tourney({ status: "signup", signupOpensAt: 2_000 });
    expect(statusPill(event, 1_000)).toEqual({ label: "tournaments.status.notOpenYet", tone: "presignup" });
    expect(statusPill(event, 3_000).tone).toBe("signup");
  });

  it("puts an abandoned event above its status", () => {
    expect(statusPill(tourney({ status: "running", abandoned: true }), 0).tone).toBe("abandoned");
  });
});

describe("stages", () => {
  it("calls the middle stage the draft for a draft event and marks where it is", () => {
    const steps = stages(tourney({ status: "draft", formation: "draft" }));
    expect(steps.map((step) => step.label)).toEqual([
      "tournaments.stage.signups",
      "tournaments.stage.draft",
      "tournaments.section.bracket",
      "tournaments.stage.results",
    ]);
    expect(steps.map((step) => step.state)).toEqual(["done", "now", "next", "next"]);
  });

  it("plays rounds rather than a bracket in a Swiss", () => {
    expect(stages(tourney({ bracketKind: "swiss" }))[2].label).toBe("tournaments.section.rounds");
  });
});

describe("eventDaysLabel", () => {
  it("is empty for a single day", () => {
    expect(eventDaysLabel(["2026-09-12"])).toBe("");
  });

  it("joins runs and names each month and year once", () => {
    expect(eventDaysLabel(["2026-09-13", "2026-09-12"])).toBe("12–13 Sep 2026");
    expect(eventDaysLabel(["2026-09-12", "2026-09-13", "2026-09-19", "2026-09-20"])).toBe(
      "12–13 & 19–20 Sep 2026",
    );
    expect(eventDaysLabel(["2026-09-30", "2026-10-01"])).toBe("30 Sep–1 Oct 2026");
    expect(eventDaysLabel(["2026-12-31", "2027-01-01"])).toBe("31 Dec 2026–1 Jan 2027");
  });
});

describe("listKind", () => {
  it("writes the format the way the website's cards do", () => {
    expect(listKind(tourney({ teamSize: 2, bracketKind: "single" }))).toBe("2v2 SE");
    expect(listKind(tourney({ teamSize: 1, bracketKind: "swiss" }))).toBe("1v1 Swiss");
    expect(listKind(tourney({ competition: "freeForAll" }))).toBe("FFA");
  });
});

describe("listCountdowns", () => {
  it("counts to the opening first, and to the close only once signups are open", () => {
    const waiting = tourney({ status: "signup", signupOpensAt: 200, signupClosesAt: 500, eventDate: 900 });
    expect(listCountdowns(waiting, 100)).toEqual({ signupsOpen: 200, eventStarts: 900, signupsClose: null });
    expect(listCountdowns(waiting, 300)).toEqual({ signupsOpen: null, eventStarts: 900, signupsClose: 500 });
  });

  it("counts nothing for an abandoned event", () => {
    const off = tourney({ status: "signup", abandoned: true, eventDate: 900 });
    expect(listCountdowns(off, 100)).toEqual({ signupsOpen: null, eventStarts: null, signupsClose: null });
  });
});

describe("archiveByYear", () => {
  it("groups by year, newest first, with undated events last", () => {
    const years = archiveByYear([
      tourney({ id: "a", eventDate: Date.UTC(2025, 0, 2) / 1000 }),
      tourney({ id: "b", eventDate: null }),
      tourney({ id: "c", eventDate: Date.UTC(2026, 5, 1) / 1000 }),
    ]);
    expect(years.map((held) => [held.year, held.events.map((event) => event.id)])).toEqual([
      [2026, ["c"]],
      [2025, ["a"]],
      [null, ["b"]],
    ]);
  });
});

describe("turnInfo", () => {
  const viewer = { ...tourney().viewer, signedUpPlayerId: "p1", memberTeamId: "t1" };
  const sides = {
    teams: [team({ id: "t1", name: "Mine" }), team({ id: "t2", name: "Theirs", captainId: "p2", playerIds: ["p2"] })],
    players: [player({ id: "p1" }), player({ id: "p2", teamId: "t2" })],
  };

  it("asks for the opponent's reported score to be confirmed before anything else", () => {
    const event = tourney({
      ...sides,
      viewer,
      myMentionCount: 3,
      matches: [match({ pendingReport: { byTeam: "t2", score1: 2, score2: 1 } as never })],
    });
    const info = turnInfo(event, t);
    expect(info?.section).toBe("bracket");
    expect(info?.text).toBe('tournaments.turn.confirmScore{"score":"2–1"}');
  });

  it("does not ask the team that reported to confirm its own score", () => {
    const event = tourney({
      ...sides,
      viewer,
      matches: [match({ pendingReport: { byTeam: "t1", score1: 2, score2: 1 } as never })],
    });
    expect(turnInfo(event, t as never)).toBeNull();
  });

  it("sends a mentioned account to the chat", () => {
    expect(turnInfo(tourney({ myMentionCount: 2 }), t as never)?.section).toBe("chat");
  });

  it("tells an organiser about pings, and nobody else", () => {
    expect(turnInfo(tourney({ chatPingCount: 1 }), t as never)).toBeNull();
    const organiser = tourney({ chatPingCount: 1, viewer: { ...tourney().viewer, organiser: true } });
    expect(turnInfo(organiser, t as never)?.cta).toBe("tournaments.turn.openChat");
  });
});
