// @vitest-environment happy-dom
//
// Recent results under the queues: with nothing to list it is one slim line
// (heading, state, profile link), and the full card with its table only once
// there are games. A failed load offers Retry in either shape, and an
// opponent whose player menu is open stays marked in the row it came from.

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReplayPlayer, VaultReplay, VaultStatus } from "../../../ipc/bindings";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { clearSentCommands, seedStore, sentCommands } from "../../../testing/mounted";
import { MatchmakerRecentGames } from "./MatchmakerRecentGames";

vi.mock("../../../ipc/client");

failOnConsoleError();

const player = (name: string, outcome: string): ReplayPlayer => ({
  name,
  avatarUrl: null,
  faction: 1,
  rating: 1000,
  ratingChange: 12,
  outcome,
  score: null,
});

const game = {
  uid: 4242,
  map: "scmp_009",
  mapThumbnailUrl: "",
  startTime: "2026-10-05T22:00:00Z",
  replayAvailable: true,
  teams: [
    { team: 2, players: [player("Nory", "VICTORY")] },
    { team: 3, players: [player("Bob", "DEFEAT")] },
  ],
} as unknown as VaultReplay;

// Two opponents in one row, and one of them, Bob, again in the 1v1 above.
const teamGame = {
  uid: 4343,
  map: "scmp_015",
  mapThumbnailUrl: "",
  startTime: "2026-10-04T22:00:00Z",
  replayAvailable: true,
  teams: [
    { team: 2, players: [player("Nory", "VICTORY"), player("Ann", "VICTORY")] },
    { team: 3, players: [player("Bob", "DEFEAT"), player("Carl", "DEFEAT")] },
  ],
} as unknown as VaultReplay;

const LOAD = { kind: "Replays", command: { type: "loadRecentMatchmaker" } };

function mount(games: VaultReplay[], status: VaultStatus) {
  seedStore((state) => ({
    ...state,
    replays: { ...state.replays, recentMatchmaker: games, recentMatchmakerStatus: status },
  }));
  const { container } = render(<MatchmakerRecentGames playerName="Nory" vault={[]} />);
  return container.querySelector(".matchmaker-recent");
}

/** The body row of one game, found by its replay button. */
function rowOf(uid: number) {
  const row = screen.getByRole("button", { name: `Open replay #${uid} in the replay vault` }).closest("tr");
  if (!row) throw new Error(`no row for ${uid}`);
  return row;
}

/**
 * The one name marked as the open menu's, by identity: two marked names
 * would compare equal node for node, so this insists on exactly one.
 */
function markedName(): Element | null {
  const marked = document.querySelectorAll(".matchmaker-recent-opponent.is-menu-open");
  expect(marked.length).toBeLessThanOrEqual(1);
  return marked[0] ?? null;
}

describe("MatchmakerRecentGames", () => {
  it("is one slim line while there are no games", () => {
    const section = mount([], { type: "ready" });

    expect(section?.classList.contains("is-compact")).toBe(true);
    expect(screen.getByRole("heading", { name: "Recent results" })).toBeTruthy();
    expect(screen.getByText("No matchmaker games yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "View results on profile" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText("Your games")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("asks for the games once when it mounts", () => {
    mount([], { type: "idle" });

    expect(sentCommands()).toEqual([LOAD]);
  });

  it("says why on the same line when the load failed", () => {
    mount([], { type: "failed", payload: { reason: "timed out" } });

    expect(screen.getByRole("alert").textContent).toBe("Could not load your recent games: timed out");
  });

  it("sends the same load again from Retry on the slim line", async () => {
    const user = userEvent.setup();
    const section = mount([], { type: "failed", payload: { reason: "timed out" } });
    clearSentCommands();

    // Still the one line: the heading, the state, Retry and the profile link.
    expect(section?.classList.contains("is-compact")).toBe(true);
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(sentCommands()).toEqual([LOAD]);
  });

  it("offers Retry in the full card when a reload fails after games were listed", async () => {
    const user = userEvent.setup();
    const section = mount([game], { type: "failed", payload: { reason: "timed out" } });
    clearSentCommands();

    expect(section?.classList.contains("is-compact")).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe("Could not load your recent games: timed out");
    expect(screen.queryByRole("table")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(sentCommands()).toEqual([LOAD]);
  });

  it("is the full card with its table once there are games", () => {
    const section = mount([game], { type: "ready" });

    expect(section?.classList.contains("is-compact")).toBe(false);
    expect(screen.getByText("Your games")).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("marks the opponent and the row a player menu was opened from, and only those", async () => {
    const user = userEvent.setup();
    mount([game, teamGame], { type: "ready" });
    const team = rowOf(4343);
    const duel = rowOf(4242);

    fireEvent.contextMenu(within(team).getByText("Bob"));

    expect(screen.getByRole("menu")).toBeTruthy();
    expect(markedName()).toBe(within(team).getByText("Bob"));
    expect(within(team).getByText("Carl").classList.contains("is-menu-open")).toBe(false);
    // The same player in another game is not where this menu came from.
    expect(within(duel).getByText("Bob").classList.contains("is-menu-open")).toBe(false);
    expect(team.classList.contains("is-menu-open")).toBe(true);
    expect(duel.classList.contains("is-menu-open")).toBe(false);

    // Another name in the same row moves the mark with the menu.
    fireEvent.contextMenu(within(team).getByText("Carl"));
    expect(markedName()).toBe(within(team).getByText("Carl"));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).toBeNull();
    expect(markedName()).toBeNull();
    expect(team.classList.contains("is-menu-open")).toBe(false);
  });
});

describe("MatchmakerRecentGames column dividers", () => {
  it("saves a width moved with the arrow keys", async () => {
    // A keyboard nudge drags and commits in one keypress. The commit used to
    // read the widths from before the nudge, so nothing was saved.
    const user = userEvent.setup();
    mount([game], { type: "ready" });
    clearSentCommands();

    const divider = screen.getAllByRole("separator")[1];
    divider.focus();
    await user.keyboard("{ArrowRight}");

    const saved = sentCommands().flatMap((command) =>
      command.kind === "Settings"
      && command.command.type === "patchBrowsing"
      && command.command.payload.patch.matchmakerRecentColumns
        ? [command.command.payload.patch.matchmakerRecentColumns]
        : [],
    );
    expect(saved).toHaveLength(1);
    expect(saved[0].length).toBeGreaterThan(0);
  });
});

describe("MatchmakerRecentGames in a narrow card", () => {
  /** Mounts the table as if it had `width` pixels, and reads its columns. */
  function mountAt(width: number) {
    const spy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(width);
    try {
      mount([game], { type: "ready" });
    } finally {
      spy.mockRestore();
    }
    const cols = [...document.querySelectorAll("colgroup col")].map((col) =>
      Number.parseFloat((col as HTMLElement).style.width) || 0,
    );
    return { cols, watch: within(rowOf(4242)).getByRole("button", { name: "Watch" }) };
  }

  it("keeps the map and the opponents readable at 1280 pixels with chat open", () => {
    // About 478 pixels for the table. The names used to go down to 50 and 40
    // pixels ("Set...", "Op...") while Watch kept its whole label.
    const { cols, watch } = mountAt(478);

    // Designed order: picture, map (flexible, no width of its own), mode,
    // opponents, played, result, rating change, replay buttons.
    expect(cols[3]).toBeGreaterThanOrEqual(80);
    expect(478 - cols.reduce((total, width) => total + width, 0)).toBeGreaterThanOrEqual(88);
    // Watch is an icon here, its name still on the button.
    expect(watch.textContent?.trim()).toBe("");
  });

  it("keeps Watch's label at the replay column's designed width", () => {
    const { watch } = mountAt(1400);

    expect(watch.textContent).toContain("Watch");
  });
});
