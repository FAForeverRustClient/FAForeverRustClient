// @vitest-environment happy-dom
//
// The selected event, mounted against a seeded store: the header's entry
// buttons go out through the grouped command contract (`tourneyActions`) and
// the pane follows the backend's answer rather than assuming it.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Tourney } from "../../ipc/bindings";
import { roundKeyOf } from "../../shared/rules/tourneyRules";
import { applyEvent, seedStore, sentCommands } from "../../testing/mounted";
import { match, player, team, tourney } from "./fixtures";
import { TournamentEventDetail } from "./TournamentEventDetail";

vi.mock("../../ipc/client");

const entered = tourney({
  id: "e1a2b",
  name: "Spring Cup",
  status: "signup",
  viewer: { ...tourney().viewer, signedUpPlayerId: "p1" },
});

function mountDetail(event: Tourney) {
  seedStore((state) => ({
    ...state,
    tourney: { ...state.tourney, events: [event], selectedId: event.id, detail: event },
  }));
  const onSignUp = vi.fn();
  render(<TournamentEventDetail jump={null} onOpenPage={() => undefined} onSignUp={onSignUp} onReport={() => undefined} />);
  return { onSignUp };
}

describe("TournamentEventDetail, mounted", () => {
  it("withdraws through the event's command and redraws when the backend's detail says so", async () => {
    const user = userEvent.setup();
    const { onSignUp } = mountDetail(entered);

    expect(screen.getByRole("heading", { name: "Spring Cup" })).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(sentCommands()).toContainEqual({
      kind: "Tourney",
      command: { type: "withdraw", payload: { tournamentId: "e1a2b" } },
    });
    // Still entered until the service answers.
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeDefined();

    applyEvent({
      kind: "Tourney",
      event: {
        type: "detailLoaded",
        payload: { event: { ...entered, viewer: { ...entered.viewer, signedUpPlayerId: null } } },
      },
    });
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();

    // Entering again opens the tab's signup dialog for this event.
    await user.click(screen.getByRole("button", { name: /Enter tournament/ }));
    expect(onSignUp).toHaveBeenCalledWith("e1a2b");
  });

  it("asks for the chat rooms the first time the Chat section opens, and not again", async () => {
    const user = userEvent.setup();
    mountDetail(entered);
    const sections = screen.getByRole("navigation", { name: "Tournament sections" });
    const chat = within(sections).getByRole("button", { name: /^Chat/ });

    await user.click(chat);
    const loads = () => sentCommands().filter((command) => command.kind === "Tourney" && command.command.type === "loadChat");
    expect(loads()).toEqual([{ kind: "Tourney", command: { type: "loadChat", payload: { tournamentId: "e1a2b" } } }]);

    applyEvent({
      kind: "Tourney",
      event: {
        type: "chatRoomsLoaded",
        payload: {
          rooms: [
            { id: "global", name: "Global", unread: 0, done: false, mentioned: false, needsOrganiser: false, count: 0 },
          ],
        },
      },
    });
    expect(screen.getByRole("tab", { name: "Global" })).toBeDefined();

    // Away and back: the rooms are here now, so nothing is asked for again.
    await user.click(within(sections).getByRole("button", { name: "Overview" }));
    await user.click(within(sections).getByRole("button", { name: /^Chat/ }));
    expect(loads()).toHaveLength(1);
  });

  it("shows recent results with the correct scores and opens the Matches tab from the panel", async () => {
    const user = userEvent.setup();
    mountDetail(tourney({
      name: "Division Cup",
      bracketKind: "swiss",
      teamSize: 2,
      divisions: 2,
      teams: [
        team({ id: "t1", name: "Team Nory", division: 1 }),
        team({ id: "t2", name: "One-Way Ticket", division: 1 }),
      ],
      matches: [
        match({ id: "early", bracket: "swiss", division: 1, status: "done", score1: 1, score2: 0, winner: "t1", loser: "t2" }),
        match({ id: "recent", bracket: "swiss", division: 1, round: 2, status: "done", score1: -1, score2: 1, winner: "t2", loser: "t1" }),
        match({ id: "future", bracket: "swiss", division: 1, round: 3, status: "ready" }),
      ],
      roundMaps: [{ round: roundKeyOf("swiss", 2), mapIds: ["Seton's Clutch"] }],
    }));

    const panel = within(screen.getByRole("region", { name: "Recent results" }));
    const results = panel.getAllByRole("listitem");
    expect(results).toHaveLength(2);
    const latest = within(results[0]);
    expect(latest.getByText("Round 2")).toBeDefined();
    expect(latest.getByText("King division")).toBeDefined();
    expect(latest.getByText("Team Nory")).toBeDefined();
    expect(latest.getByText("FF – 1")).toBeDefined();
    expect(latest.getByText("One-Way Ticket")).toBeDefined();
    expect(latest.getByText("Seton's Clutch")).toBeDefined();
    expect(latest.getByText("Record 1-0 vs 0-1")).toBeDefined();

    await user.click(panel.getByRole("button", { name: "Matches" }));
    expect(screen.getByRole("button", { name: "Matches", current: true })).toBeDefined();
  });

  it("shows the assigned divisions separately and keeps unassigned teams and reserves visible", async () => {
    const user = userEvent.setup();
    mountDetail(tourney({
      name: "Division Cup",
      teamSize: 2,
      divisions: 2,
      teams: [
        team({ id: "p", name: "Prince Team", division: 2, seed: 1 }),
        team({ id: "k", name: "King Team", division: 1, seed: 2 }),
        team({ id: "k2", name: "King Rivals", division: 1, seed: 4 }),
        team({ id: "u", name: "Pending Team", division: 0, seed: 3 }),
      ],
      players: [player({ id: "reserve", name: "Ada", teamId: null })],
      subs: ["reserve"],
    }));

    await user.click(screen.getByRole("button", { name: "Teams" }));
    const sections = ["King division", "Prince division", "Division unassigned"].map((name) => {
      const section = screen.getByRole("heading", { name: new RegExp(name) }).closest("section");
      if (section === null) throw new Error("Missing team section");
      const items = within(section).getAllByRole("listitem");
      for (const item of items) expect(within(item).queryByText("1", { exact: true })).toBeNull();
      return items.map((item) => item.textContent);
    });
    expect(sections.map((items) => items[0])).toEqual([
      expect.stringContaining("King Team"),
      expect.stringContaining("Prince Team"),
      expect.stringContaining("Pending Team"),
    ]);
    expect(sections[0][1]).toContain("King Rivals");
    const reserves = screen.getByRole("button", { name: "Reserve players 1" });
    const king = screen.getByRole("heading", { name: /King division/ });
    expect(reserves.compareDocumentPosition(king) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reserves.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Ada" })).toBeNull();
    await user.click(reserves);
    expect(reserves.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Ada" })).toBeDefined();
    await user.click(reserves);
    expect(screen.queryByRole("button", { name: "Ada" })).toBeNull();
    expect(screen.queryByText("Free agents")).toBeNull();
  });

  it("shows each Swiss division's own results and champion in its standings table", async () => {
    const user = userEvent.setup();
    mountDetail(tourney({
      name: "Division Cup",
      bracketKind: "swiss",
      teamSize: 2,
      divisions: 2,
      teams: [
        team({ id: "k1", name: "King Leader", division: 1, seed: 1 }),
        team({ id: "k2", name: "King Runner-up", division: 1, seed: 2 }),
        team({ id: "p1", name: "Prince Leader", division: 2, seed: 1 }),
        team({ id: "p2", name: "Prince Champion", division: 2, seed: 2 }),
      ],
      matches: [
        match({ id: "king", bracket: "swiss", division: 1, team1: "k1", team2: "k2", status: "done", winner: "k1", loser: "k2", score1: 2, score2: 0 }),
        match({ id: "prince", bracket: "swiss", division: 2, team1: "p1", team2: "p2", status: "done", winner: "p1", loser: "p2", score1: 2, score2: 1 }),
        match({ id: "final", bracket: "grandFinal", division: 2, team1: "p1", team2: "p2", status: "done", winner: "p2", loser: "p1" }),
      ],
    }));

    await user.click(screen.getByRole("button", { name: "Standings" }));
    const king = within(screen.getByRole("table", { name: "King division" }));
    const prince = within(screen.getByRole("table", { name: "Prince division" }));
    expect(king.getByRole("rowheader", { name: "King Leader" })).toBeDefined();
    expect(king.getByRole("cell", { name: "+2" })).toBeDefined();
    expect(king.queryByRole("img", { name: "Champion" })).toBeNull();
    expect(king.queryByText("Prince Leader")).toBeNull();
    expect(prince.getByText("Prince Leader")).toBeDefined();
    expect(prince.getByRole("img", { name: "Champion" })).toBeDefined();
  });

  it("prompts a captain to pick, and not once they are in the draft", async () => {
    const user = userEvent.setup();
    mountDetail(
      tourney({
        id: "e1a2b",
        name: "Captains Cup",
        status: "draft",
        formation: "draft",
        teamSize: 2,
        players: [
          player({ id: "p1", name: "Ada", teamId: "t1" }),
          player({ id: "p2", name: "Bob", teamId: "t2" }),
          player({ id: "p3", name: "Cid", teamId: null }),
        ],
        teams: [
          team({ id: "t1", captainId: "p1", playerIds: ["p1"] }),
          team({ id: "t2", captainId: "p2", playerIds: ["p2"] }),
        ],
        draft: { order: ["t1", "t2"], current: 0, lastPick: null },
        viewer: { ...tourney().viewer, signedUpPlayerId: "p1", memberTeamId: "t1" },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Go to the draft" }));
    expect(screen.getByRole("button", { name: "Teams", current: true })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Go to the draft" })).toBeNull();
  });

  it("shows an error notice with retry when loading the selected tournament fails", async () => {
    const user = userEvent.setup();
    seedStore((state) => ({
      ...state,
      tourney: {
        ...state.tourney,
        selectedId: "e1a2b",
        detail: null,
        detailStatus: { type: "failed", payload: { reason: "Network unreachable", kind: "offline" } },
      },
    }));
    render(<TournamentEventDetail jump={null} onOpenPage={() => undefined} onSignUp={() => undefined} onReport={() => undefined} />);
    expect(screen.getByRole("alert")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(sentCommands()).toContainEqual({
      kind: "Tourney",
      command: { type: "select", payload: { tournamentId: "e1a2b" } },
    });
  });
});
