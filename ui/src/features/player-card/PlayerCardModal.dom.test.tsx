// @vitest-environment happy-dom
//
// The player card, mounted against the store, through the requests that race
// each other on it: a second player opened from the card's own search while
// the first player's map scan is still out, a card closed while its profile is
// loading, and a failed profile retried.
//
// The profile answer itself carries no request id, so the card shows whichever
// profile the backend sends; the backend's generation guard
// (`faf-app/src/services/player_card.rs`) is what drops a superseded one. What
// the view does guard is the per-map scan, which carries its player and is
// shown only under that player's card, and a newly opened player lands on
// Overview without first mounting whatever tab the previous player was left
// on, which used to start the new player's map scan unasked.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppCommand, PlayerCardEvent, PlayerCardProfile, PlayerMapStats } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, sentCommands } from "../../testing/mounted";
import { PlayerCardModal } from "./PlayerCardModal";

vi.mock("../../ipc/client");

failOnConsoleError();

// Ids of their own: `usePlayerHistory` remembers the last player it asked
// about at module level, for the whole file.
const ALICE = 9_101;
const BOB = 9_202;

function profile(playerId: number, login: string): PlayerCardProfile {
  return {
    playerId,
    login,
    country: "",
    registeredAt: "2020-01-01T00:00:00Z",
    userAgent: "",
    avatars: [],
    names: [],
    clan: null,
    ratings: [],
    leaguePlacements: [],
    events: [],
    achievements: [],
    warnings: [],
    matchedFormerName: null,
  };
}

function mapStats(playerId: number, map: string): PlayerMapStats {
  return {
    totalGames: 3,
    rankedGames: 3,
    wins: 2,
    losses: 1,
    undecided: 0,
    unranked: 0,
    unattributed: 0,
    maps: [{ map, generated: false, games: 3, wins: 2, losses: 1, draws: 0, lastPlayed: "2026-01-01T00:00:00Z" }],
    truncated: false,
    playerId,
  };
}

const cardEvent = (event: PlayerCardEvent) => applyEvent({ kind: "PlayerCard", event });

function sentPlayerCard(type: string): AppCommand[] {
  return sentCommands().filter((command) => command.kind === "PlayerCard" && command.command.type === type);
}

/** The card as the backend leaves it once a profile has loaded. */
function mountOpenCard(playerId: number, login: string) {
  cardEvent({ type: "loading", payload: { login } });
  cardEvent({ type: "loaded", payload: { profile: profile(playerId, login) } });
  const view = render(<PlayerCardModal />);
  return view;
}

const card = (login: string) => screen.getByRole("dialog", { name: `Player card: ${login}` });

describe("PlayerCardModal request races, mounted", () => {
  it("lands a newly opened player on Overview without starting a map scan nobody asked for", async () => {
    const user = userEvent.setup();
    mountOpenCard(ALICE + 1, "Carol");
    await user.click(within(card("Carol")).getByRole("tab", { name: "Maps" }));
    cardEvent({ type: "mapStatsLoading", payload: { playerId: ALICE + 1 } });
    cardEvent({ type: "mapStatsLoaded", payload: { stats: mapStats(ALICE + 1, "Seton's Clutch") } });
    expect(within(card("Carol")).getByText("Seton's Clutch")).toBeTruthy();

    // Another name opened while the Maps tab is showing, as a click in chat
    // or the card's own search does.
    clearSentCommands();
    cardEvent({ type: "loading", payload: { login: "Dave" } });
    cardEvent({ type: "loaded", payload: { profile: profile(BOB + 1, "Dave") } });

    expect(within(card("Dave")).getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    // The scan is the most expensive thing a profile loads, and is asked for
    // when its tab is opened, not because the previous player's was.
    expect(sentPlayerCard("loadMapStats")).toEqual([]);

    await user.click(within(card("Dave")).getByRole("tab", { name: "Maps" }));
    expect(sentPlayerCard("loadMapStats")).toEqual([
      { kind: "PlayerCard", command: { type: "loadMapStats", payload: { playerId: BOB + 1 } } },
    ]);
  });

  it("never shows the first player's late map scan under the second player's card", async () => {
    const user = userEvent.setup();
    mountOpenCard(ALICE, "Alice");

    // Alice's scan goes out and is still running when Bob is opened.
    await user.click(within(card("Alice")).getByRole("tab", { name: "Maps" }));
    expect(sentPlayerCard("loadMapStats")).toEqual([
      { kind: "PlayerCard", command: { type: "loadMapStats", payload: { playerId: ALICE } } },
    ]);
    cardEvent({ type: "mapStatsLoading", payload: { playerId: ALICE } });

    clearSentCommands();
    await user.type(screen.getByRole("textbox", { name: "Investigate another player" }), "Bob{Enter}");
    expect(sentPlayerCard("open")).toEqual([
      { kind: "PlayerCard", command: { type: "open", payload: { playerId: null, login: "Bob" } } },
    ]);

    cardEvent({ type: "loading", payload: { login: "Bob" } });
    expect(within(card("Bob")).getByText("Loading complete player profile…")).toBeTruthy();
    cardEvent({ type: "loaded", payload: { profile: profile(BOB, "Bob") } });

    clearSentCommands();
    await user.click(within(card("Bob")).getByRole("tab", { name: "Maps" }));
    expect(sentPlayerCard("loadMapStats")).toEqual([
      { kind: "PlayerCard", command: { type: "loadMapStats", payload: { playerId: BOB } } },
    ]);

    // Alice's answer lands before Bob's scan has started.
    cardEvent({ type: "mapStatsLoaded", payload: { stats: mapStats(ALICE, "Seton's Clutch") } });
    expect(screen.queryByText("Seton's Clutch")).toBeNull();
    expect(card("Bob")).toBeTruthy();

    cardEvent({ type: "mapStatsLoading", payload: { playerId: BOB } });
    cardEvent({ type: "mapStatsLoaded", payload: { stats: mapStats(BOB, "Dual Gap") } });
    expect(within(card("Bob")).getByText("Dual Gap")).toBeTruthy();
    expect(screen.queryByText("Seton's Clutch")).toBeNull();
  });

  it("stays closed when the profile it was loading answers after the card was closed", async () => {
    const user = userEvent.setup();
    cardEvent({ type: "loading", payload: { login: "Alice" } });
    render(<PlayerCardModal />);
    expect(within(card("Alice")).getByText("Loading complete player profile…")).toBeTruthy();

    await user.click(within(card("Alice")).getByRole("button", { name: "Close" }));
    expect(sentPlayerCard("close")).toEqual([{ kind: "PlayerCard", command: { type: "close" } }]);
    cardEvent({ type: "closed" });
    expect(screen.queryByRole("dialog")).toBeNull();

    cardEvent({ type: "loaded", payload: { profile: profile(ALICE, "Alice") } });
    cardEvent({ type: "loadFailed", payload: { reason: "timed out" } });
    cardEvent({ type: "mapStatsLoaded", payload: { stats: mapStats(ALICE, "Seton's Clutch") } });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("drops a map scan that answers after the card closed while its tab was open", async () => {
    const user = userEvent.setup();
    mountOpenCard(ALICE, "Alice");
    await user.click(within(card("Alice")).getByRole("tab", { name: "Maps" }));
    cardEvent({ type: "mapStatsLoading", payload: { playerId: ALICE } });
    expect(within(card("Alice")).getByText("Reading this player's games…")).toBeTruthy();

    await user.keyboard("{Escape}");
    cardEvent({ type: "closed" });
    expect(screen.queryByRole("dialog")).toBeNull();

    cardEvent({ type: "mapStatsLoaded", payload: { stats: mapStats(ALICE, "Seton's Clutch") } });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says a failed profile plainly, keeps the reason on hover, and asks for the same player again", async () => {
    const user = userEvent.setup();
    cardEvent({ type: "loading", payload: { login: "Alice" } });
    render(<PlayerCardModal />);
    const reason = "GET https://api.faforever.com/data/player returned HTTP 502";
    cardEvent({ type: "loadFailed", payload: { reason } });

    const dialog = card("Alice");
    const alert = within(dialog).getByRole("alert");
    expect(within(alert).getByText(en["errors.cause.server"]).getAttribute("title")).toBe(reason);
    expect(alert.textContent).not.toContain("HTTP 502");
    clearSentCommands();
    await user.click(within(alert).getByRole("button", { name: en["common.retry"] }));
    expect(sentPlayerCard("open")).toEqual([
      { kind: "PlayerCard", command: { type: "open", payload: { playerId: null, login: "Alice" } } },
    ]);

    cardEvent({ type: "loading", payload: { login: "Alice" } });
    expect(within(card("Alice")).queryByRole("button", { name: "Retry" })).toBeNull();
    cardEvent({ type: "loaded", payload: { profile: profile(ALICE, "Alice") } });
    expect(within(card("Alice")).getByRole("tablist", { name: "Player profile sections" })).toBeTruthy();
  });

  it("words a section that could not load plainly, with the backend's text on hover", () => {
    const raw = "Ratings: HTTP 502 Bad Gateway";
    cardEvent({ type: "loading", payload: { login: "Alice" } });
    cardEvent({ type: "loaded", payload: { profile: { ...profile(ALICE, "Alice"), warnings: [raw] } } });
    render(<PlayerCardModal />);

    const item = within(card("Alice")).getByTitle(raw);
    expect(item.textContent?.startsWith("Ratings: ")).toBe(true);
    expect(item.textContent).not.toContain("HTTP 502");
  });
});
