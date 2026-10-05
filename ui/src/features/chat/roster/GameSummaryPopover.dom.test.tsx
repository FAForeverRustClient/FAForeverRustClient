// @vitest-environment happy-dom
//
// Two game badges, mounted, so the hover panels' shared timing in
// `shared/hoverPanels` actually runs: the first card waits for the delay, the
// next opens at once and puts the first away, and a card that goes away with
// its badge takes its listeners and its place in the "something is open" count
// with it.

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Game, SocialState } from "../../../ipc/bindings";
import "../../../testing/mounted";
import { GameSummaryPopover } from "./GameSummaryPopover";
import type { GamePresence } from "./gameSummary";

vi.mock("../../../ipc/client");

const social: SocialState = { friends: [], foes: [], players: [] };

function presence(id: number, title: string): GamePresence {
  const game: Game = {
    id,
    title,
    host: "Host",
    players: 2,
    maxPlayers: 8,
    map: "scmp_009",
    modName: "faf",
    averageRating: 1_200,
    ratingType: "global",
    passwordProtected: false,
    visibility: "public",
    gameType: "custom",
    launchedAt: null,
    hostedAt: null,
    ratingMin: null,
    ratingMax: null,
    enforceRatingRange: false,
    teams: { "1": ["Host"], "2": ["Guest"] },
    simMods: {},
  };
  return { game, status: "lobbying" };
}

function Badges({ second = true }: { second?: boolean }) {
  return (
    <>
      <GameSummaryPopover presence={presence(1, "First lobby")} social={social} vault={[]} />
      {second && <GameSummaryPopover presence={presence(2, "Second lobby")} social={social} vault={[]} />}
    </>
  );
}

const badge = (title: string) => screen.getByRole("button", { name: new RegExp(`${title} on`) });

/** The card a badge has open, found through the badge's own description. */
function cardOf(title: string): HTMLElement | null {
  const id = badge(title).getAttribute("aria-describedby");
  return id === null ? null : document.getElementById(id);
}

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  // Well clear of whatever the previous test closed: a panel that closed a
  // moment ago makes the next one open at once, which is the behaviour under
  // test, not something to inherit.
  vi.setSystemTime(Date.now() + 60_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GameSummaryPopover hover panels, mounted", () => {
  it("waits for the delay on a cold hover, then opens the next one at once and closes the first", () => {
    render(<Badges />);

    fireEvent.mouseEnter(badge("First lobby"));
    advance(499);
    expect(screen.queryByRole("tooltip")).toBeNull();
    advance(1);
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(cardOf("First lobby")).not.toBeNull();

    // Straight across to the next badge: the first card's close delay has not
    // run out, and it must not stay on screen under the second.
    fireEvent.mouseLeave(badge("First lobby"));
    fireEvent.mouseEnter(badge("Second lobby"));
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    expect(cardOf("Second lobby")).not.toBeNull();
    expect(cardOf("First lobby")).toBeNull();
  });

  it("closes after the close delay once the pointer has left, and stays warm only briefly", () => {
    render(<Badges second={false} />);

    fireEvent.focus(badge("First lobby"));
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);

    fireEvent.mouseLeave(badge("First lobby"));
    advance(159);
    expect(screen.queryByRole("tooltip")).not.toBeNull();
    advance(1);
    expect(screen.queryByRole("tooltip")).toBeNull();

    // Back within half a second: still warm, so no wait.
    fireEvent.mouseEnter(badge("First lobby"));
    expect(screen.queryByRole("tooltip")).not.toBeNull();
  });

  it("lets go of its listeners and its open count when its badge goes away while open", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const { rerender } = render(<Badges />);

    fireEvent.focus(badge("Second lobby"));
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);
    const resizeAdded = add.mock.calls.filter(([type]) => type === "resize").map(([, listener]) => listener);
    expect(resizeAdded).toHaveLength(1);

    rerender(<Badges second={false} />);
    expect(screen.queryByRole("tooltip")).toBeNull();
    const resizeRemoved = remove.mock.calls.filter(([type]) => type === "resize").map(([, listener]) => listener);
    expect(resizeRemoved).toEqual(resizeAdded);

    // Nothing is counted as open any more: once the warm window has passed,
    // the next hover waits for the delay again.
    advance(1_000);
    fireEvent.mouseEnter(badge("First lobby"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    advance(500);
    expect(screen.getAllByRole("tooltip")).toHaveLength(1);

    add.mockRestore();
    remove.mockRestore();
  });
});
