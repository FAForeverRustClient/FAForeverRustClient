// @vitest-environment happy-dom
//
// The matchmaker, mounted through the Play tab with the store seeded as the
// backend seeds it. The panel never decides a search's state itself: a press
// sends a command and the panel waits for `matchmakingUpdated`, so these
// follow a search through the backend's answers (preparing, searching, match
// found, launching, then ended or cancelled), a stop, a party growing under a
// running search, a rating that arrives after the cards have drawn, and a
// lobby connection that drops and comes back in the middle of all that. Two
// tests pin down what a second click sends before the backend has answered,
// because nothing in the panel holds it back.
//
// The panel's one second clock is frozen (only `setInterval` is faked), so a
// tick never lands between two steps of a test as an update outside `act`.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppCommand, MatchmakerPlayerProfile, MatchmakerQueue, MatchmakingState, PartyState } from "../../../ipc/bindings";
import { formatNumber } from "../../../i18n";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { applyEvent, seedStore, sentCommands } from "../../../testing/mounted";
import { LobbyView } from "../LobbyView";

vi.mock("../../../ipc/client");

failOnConsoleError();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
});

const ME = { id: 7, name: "Me", roles: [] };

function queue(queueName: string, teamSize: number, windows: MatchmakerQueue["boundary80s"] = []): MatchmakerQueue {
  return {
    queueName,
    teamSize,
    numPlayers: windows.length,
    queuePopTimeSeconds: 60,
    queuePopsAt: "",
    boundary80s: windows,
    boundary75s: [],
  };
}

const LADDER = queue("ladder1v1", 1);
// Two of the three waiting searches have a window around a mean of 1500.
const TEAM = queue("tmm2v2", 2, [
  { min: 1300, max: 1700 },
  { min: 1350, max: 1750 },
  { min: 2000, max: 2400 },
]);

function mountMatchmaker(party: PartyState = { ownerId: null, members: [] }) {
  seedStore((state) => ({
    ...state,
    auth: { ...state.auth, status: "loggedIn", player: ME },
    lobby: {
      ...state.lobby,
      status: "connected",
      playMode: "matchmaking",
      matchmakerQueues: [LADDER, TEAM],
      party,
    },
  }));
  render(<LobbyView />);
}

function matchmaking(state: MatchmakingState) {
  applyEvent({ kind: "Lobby", event: { type: "matchmakingUpdated", payload: { state } } });
}

/** The Lobby commands of one type, in the order they were sent. */
function lobbySent<T extends Extract<AppCommand, { kind: "Lobby" }>["command"]["type"]>(type: T) {
  return sentCommands()
    .filter((command): command is Extract<AppCommand, { kind: "Lobby" }> => command.kind === "Lobby")
    .map((command) => command.command)
    .filter((command) => command.type === type);
}

function queueCard(title: "1 vs 1" | "2 vs 2") {
  const toggle = screen.getByRole("button", { name: new RegExp(`^(Add )?${title}`) });
  const card = toggle.closest("article");
  if (!card) throw new Error(`no card for ${title}`);
  return { toggle, card };
}

const searchButton = () => screen.getByRole("button", { name: /^(Start search|Stop searching|Match found|Game starting)$/ });

describe("MatchmakingPanel, mounted", () => {
  it("starts a search with one startSearch for every selected queue and waits for the backend", async () => {
    const user = userEvent.setup();
    mountMatchmaker();
    expect(screen.getByText("2 queues selected")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Start search" }));

    expect(lobbySent("startSearch")).toEqual([
      { type: "startSearch", payload: { queueNames: ["ladder1v1", "tmm2v2"] } },
    ]);
    expect(lobbySent("setPartyFactions")).toHaveLength(1);
    // Nothing changes on screen until the backend says the search exists.
    expect(searchButton().textContent).toBe("Start search");
    expect(screen.getByText("2 queues selected")).toBeDefined();
  });

  it("sends startSearch again on a quick second click, because the button stays Start until the backend answers", async () => {
    // Current behaviour, recorded rather than fixed: the panel has no pending
    // state between the press and `matchmakingUpdated`, so a double click sends
    // the search twice. The service drops the second: `start_search` in
    // `crates/faf-app/src/services/lobby/matchmaking.rs` returns early on a
    // search that is already preparing.
    const user = userEvent.setup();
    mountMatchmaker();

    await user.dblClick(screen.getByRole("button", { name: "Start search" }));

    expect(lobbySent("startSearch")).toHaveLength(2);
  });

  it("follows the backend from preparing through searching, a found match and the launch, back to idle when the game ends", async () => {
    const user = userEvent.setup();
    mountMatchmaker();
    await user.click(screen.getByRole("button", { name: "Start search" }));

    matchmaking({ type: "preparing", payload: { queueNames: ["ladder1v1", "tmm2v2"] } });
    expect(screen.getByText("Getting ready to search")).toBeDefined();
    expect(screen.getByText(/Updating the game and downloading the pool maps first/)).toBeDefined();
    expect(searchButton().textContent).toBe("Stop searching");
    expect(searchButton().hasAttribute("disabled")).toBe(false);
    // The selection is frozen while the maps come down.
    expect(queueCard("1 vs 1").toggle.hasAttribute("disabled")).toBe(true);
    expect(queueCard("2 vs 2").card.getAttribute("data-status")).toBe("searching");

    matchmaking({ type: "searching", payload: { queueNames: ["ladder1v1", "tmm2v2"] } });
    expect(screen.getByText("Searching 2 queues")).toBeDefined();
    expect(screen.getByText("Queue selection stays editable while searching.")).toBeDefined();
    expect(queueCard("1 vs 1").toggle.hasAttribute("disabled")).toBe(false);
    expect(queueCard("1 vs 1").card.getAttribute("data-status")).toBe("searching");

    matchmaking({ type: "matchFound", payload: { queueName: "tmm2v2" } });
    expect(screen.getByText("Match found in tmm2v2")).toBeDefined();
    expect(searchButton().textContent).toBe("Match found");
    expect(searchButton().hasAttribute("disabled")).toBe(true);
    expect(queueCard("2 vs 2").card.getAttribute("data-status")).toBe("found");
    expect(queueCard("1 vs 1").card.getAttribute("data-status")).toBe("idle");
    expect(queueCard("1 vs 1").toggle.hasAttribute("disabled")).toBe(true);

    matchmaking({ type: "launching", payload: { queueName: "tmm2v2" } });
    expect(screen.getByText("Starting your match…")).toBeDefined();
    expect(searchButton().textContent).toBe("Game starting");
    expect(searchButton().hasAttribute("disabled")).toBe(true);
    expect(queueCard("2 vs 2").card.getAttribute("data-status")).toBe("launching");

    // The server sends no search_info when a match ends; the game ending is
    // what frees the panel.
    applyEvent({ kind: "Lobby", event: { type: "gameTerminated" } });
    expect(screen.getByText("2 queues selected")).toBeDefined();
    expect(searchButton().textContent).toBe("Start search");
    expect(searchButton().hasAttribute("disabled")).toBe(false);
    expect(queueCard("2 vs 2").card.getAttribute("data-status")).toBe("idle");
    // One search asked for, nothing sent on the way through.
    expect(lobbySent("startSearch")).toHaveLength(1);
    expect(lobbySent("matchmake")).toEqual([]);
  });

  it("says a cancelled match plainly and lets the player search again", async () => {
    const user = userEvent.setup();
    mountMatchmaker();
    matchmaking({ type: "searching", payload: { queueNames: ["ladder1v1", "tmm2v2"] } });
    matchmaking({ type: "matchFound", payload: { queueName: "ladder1v1" } });

    matchmaking({ type: "cancelled", payload: { queueName: null } });
    expect(screen.getByText("The match was cancelled. You can search again.")).toBeDefined();
    expect(queueCard("1 vs 1").card.getAttribute("data-status")).toBe("cancelled");
    expect(searchButton().textContent).toBe("Start search");

    await user.click(searchButton());
    expect(lobbySent("startSearch")).toEqual([
      { type: "startSearch", payload: { queueNames: ["ladder1v1", "tmm2v2"] } },
    ]);
  });

  it("stops a search that is still preparing with a stop for each of its queues, and goes idle only on the backend's word", async () => {
    const user = userEvent.setup();
    mountMatchmaker();
    matchmaking({ type: "preparing", payload: { queueNames: ["ladder1v1", "tmm2v2"] } });

    await user.click(screen.getByRole("button", { name: "Stop searching" }));
    expect(lobbySent("matchmake")).toEqual([
      { type: "matchmake", payload: { queueName: "ladder1v1", start: false } },
      { type: "matchmake", payload: { queueName: "tmm2v2", start: false } },
    ]);
    expect(lobbySent("startSearch")).toEqual([]);
    expect(searchButton().textContent).toBe("Stop searching");

    matchmaking({ type: "idle" });
    expect(searchButton().textContent).toBe("Start search");
    expect(queueCard("1 vs 1").toggle.hasAttribute("disabled")).toBe(false);
    expect(queueCard("2 vs 2").card.getAttribute("data-status")).toBe("idle");
  });

  it("stops only the queues the running search covers", async () => {
    const user = userEvent.setup();
    mountMatchmaker();
    matchmaking({ type: "searching", payload: { queueNames: ["tmm2v2"] } });
    expect(screen.getByText("Searching 1 queue")).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Stop searching" }));
    expect(lobbySent("matchmake")).toEqual([
      { type: "matchmake", payload: { queueName: "tmm2v2", start: false } },
    ]);

    matchmaking({ type: "idle" });
    expect(searchButton().textContent).toBe("Start search");
  });

  it("sends the stops again on a quick second click, because the button stays Stop until the backend answers", async () => {
    // Current behaviour, recorded rather than fixed. The server answers a
    // stop for a search it no longer has with nothing, so the second is two
    // messages for one intent rather than a fault.
    const user = userEvent.setup();
    mountMatchmaker();
    matchmaking({ type: "searching", payload: { queueNames: ["tmm2v2"] } });

    await user.dblClick(screen.getByRole("button", { name: "Stop searching" }));
    expect(lobbySent("matchmake")).toEqual([
      { type: "matchmake", payload: { queueName: "tmm2v2", start: false } },
      { type: "matchmake", payload: { queueName: "tmm2v2", start: false } },
    ]);
  });

  it("shows a member who joins mid-search, keeps the search, and leaves only the queue the party outgrew", () => {
    mountMatchmaker();
    matchmaking({ type: "searching", payload: { queueNames: ["ladder1v1", "tmm2v2"] } });
    expect(screen.getByRole("heading", { name: "1 of 4 players" })).toBeDefined();

    applyEvent({
      kind: "Lobby",
      event: {
        type: "partyUpdated",
        payload: {
          party: {
            ownerId: ME.id,
            members: [
              { playerId: ME.id, name: "Me", factions: ["uef"] },
              { playerId: 8, name: "Buddy", factions: ["aeon"] },
            ],
          },
        },
      },
    });

    expect(screen.getByRole("heading", { name: "2 of 4 players" })).toBeDefined();
    expect(screen.getByText("Buddy")).toBeDefined();
    expect(screen.getByText("Party changes are locked while searching.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Leave party" }).hasAttribute("disabled")).toBe(true);
    // A pair does not fit the 1v1 ladder, so that one is left at once; the
    // 2v2 search is untouched.
    expect(lobbySent("matchmake")).toEqual([
      { type: "matchmake", payload: { queueName: "ladder1v1", start: false } },
    ]);
    expect(searchButton().textContent).toBe("Stop searching");
    expect(within(queueCard("1 vs 1").card).getByText("Party too large")).toBeDefined();

    matchmaking({ type: "searching", payload: { queueNames: ["tmm2v2"] } });
    expect(screen.getByText("Searching 1 queue")).toBeDefined();
    expect(queueCard("2 vs 2").card.getAttribute("data-status")).toBe("searching");
    expect(queueCard("1 vs 1").card.getAttribute("data-status")).toBe("idle");
    expect(lobbySent("matchmake")).toHaveLength(1);
  });

  it("sends nothing when a member joins a search every queue of which still fits", () => {
    mountMatchmaker();
    matchmaking({ type: "searching", payload: { queueNames: ["tmm2v2"] } });

    applyEvent({
      kind: "Lobby",
      event: {
        type: "partyUpdated",
        payload: {
          party: {
            ownerId: ME.id,
            members: [
              { playerId: ME.id, name: "Me", factions: [] },
              { playerId: 8, name: "Buddy", factions: [] },
            ],
          },
        },
      },
    });

    expect(screen.getByText("Buddy")).toBeDefined();
    expect(lobbySent("matchmake")).toEqual([]);
    expect(screen.getByText("Searching 1 queue")).toBeDefined();
  });

  it("fills in the queue card's rating and in-range line when the profile arrives after the first render", () => {
    mountMatchmaker();
    const { card } = queueCard("2 vs 2");

    // Before the profile: no rating, and the in-range line is held in place
    // but hidden, because there is no answer yet.
    expect(within(card).getByText("N/A")).toBeDefined();
    const pending = within(card).getByText("0 in your range");
    expect(pending.getAttribute("aria-hidden")).toBe("true");
    expect(pending.className).toBe("matchmaker-queue-fact-pending");
    expect(sentCommands()).toContainEqual({
      kind: "PlayerCard",
      command: { type: "loadMatchmakerProfile", payload: { playerId: ME.id, login: "Me" } },
    });

    const profile: MatchmakerPlayerProfile = {
      playerId: ME.id,
      login: "Me",
      country: "",
      clanTag: "",
      avatarUrl: "",
      avatarTooltip: "",
      gamesPlayed: 120,
      ratings: [
        {
          leaderboardId: 3,
          technicalName: "tmm_2v2",
          rating: 1260,
          mean: 1500,
          deviation: 80,
          gamesPlayed: 120,
          wonGames: 60,
          updateTime: "2026-10-01T12:00:00Z",
        },
      ],
      leaguePlacements: [],
      warnings: [],
    };
    applyEvent({ kind: "PlayerCard", event: { type: "matchmakerProfileLoaded", payload: { profile } } });

    expect(within(card).queryByText("N/A")).toBeNull();
    expect(within(card).getByText(formatNumber(1260))).toBeDefined();
    const answered = within(card).getByText("2 in your range");
    expect(answered.hasAttribute("aria-hidden")).toBe(false);
    expect(answered.className).toBe("");
    expect(answered.getAttribute("title")).toMatch(/could be matched with you/);
    // The 1v1 card has no rating for that board and stays unanswered.
    expect(within(queueCard("1 vs 1").card).getByText("0 in your range").getAttribute("aria-hidden")).toBe("true");
  });

  it("drops a running search on a reconnect, empties the tab while disconnected, and comes back idle", () => {
    mountMatchmaker();
    matchmaking({ type: "searching", payload: { queueNames: ["ladder1v1", "tmm2v2"] } });
    expect(searchButton().textContent).toBe("Stop searching");

    // The server ends a search with the connection it was made on.
    applyEvent({ kind: "Lobby", event: { type: "connecting" } });
    expect(searchButton().textContent).toBe("Start search");
    expect(queueCard("1 vs 1").card.getAttribute("data-status")).toBe("idle");
    expect(queueCard("2 vs 2").card.getAttribute("data-status")).toBe("idle");

    applyEvent({ kind: "Lobby", event: { type: "disconnected" } });
    expect(screen.getByText("Loading matchmaker queues")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Start search|Stop searching/ })).toBeNull();

    applyEvent({ kind: "Lobby", event: { type: "connected" } });
    applyEvent({ kind: "Lobby", event: { type: "matchmakerQueuesUpdated", payload: { queues: [LADDER, TEAM] } } });
    expect(searchButton().textContent).toBe("Start search");
    expect(searchButton().hasAttribute("disabled")).toBe(false);
    expect(screen.getByText("2 queues selected")).toBeDefined();
    // The panel did not answer the drop by sending anything of its own.
    expect(lobbySent("matchmake")).toEqual([]);
    expect(lobbySent("startSearch")).toEqual([]);
  });

  it("keeps a launching match locked through a reconnect blip and frees it once the connection is lost", () => {
    mountMatchmaker();
    matchmaking({ type: "launching", payload: { queueName: "tmm2v2" } });

    applyEvent({ kind: "Lobby", event: { type: "connecting" } });
    expect(searchButton().textContent).toBe("Game starting");
    expect(searchButton().hasAttribute("disabled")).toBe(true);

    applyEvent({ kind: "Lobby", event: { type: "disconnected" } });
    applyEvent({ kind: "Lobby", event: { type: "connected" } });
    applyEvent({ kind: "Lobby", event: { type: "matchmakerQueuesUpdated", payload: { queues: [LADDER, TEAM] } } });
    expect(searchButton().textContent).toBe("Start search");
    expect(searchButton().hasAttribute("disabled")).toBe(false);
    expect(queueCard("2 vs 2").card.getAttribute("data-status")).toBe("idle");
  });
});
