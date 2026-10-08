// @vitest-environment happy-dom
//
// The join progress dialog, mounted against the store as the shell mounts it.
// Cancelling sends one `cancelJoin` and the dialog stays until the backend
// confirms with `joinCancelled`; answers that arrive after that (a refusal
// for the join that was called off, a second confirmation) leave it closed
// and raise nothing. Hiding is not cancelling: it sends nothing, stays hidden
// while the same join runs on, and the next join is shown again.
//
// One test records a limit of the protocol rather than of the dialog: a
// `preparing` frame carries no join id, so a stale one arriving after the
// cancel is indistinguishable from a new join and brings the dialog back.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { GameLaunch, LobbyEvent } from "../../../ipc/bindings";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { applyEvent, seedStore, sentCommands } from "../../../testing/mounted";
import { JoinPreparationDialog } from "./JoinPreparationDialog";

vi.mock("../../../ipc/client");

failOnConsoleError();

const GAME_ID = 4242;

const LAUNCH: GameLaunch = {
  uid: GAME_ID,
  mod: "faf",
  name: "Friday Setons",
  mapname: "setons_clutch",
  gameType: "custom",
  ratingType: "global",
  expectedPlayers: null,
  team: null,
  faction: null,
  mapPosition: null,
  gameOptions: {},
  args: [],
};

function lobby(event: LobbyEvent) {
  applyEvent({ kind: "Lobby", event });
}

function progress(detail: string, value: number | null) {
  lobby({ type: "preparing", payload: { phase: "downloading", detail, progress: value } });
}

/** Mount with a join already downloading, as the backend reports it. */
function mountPreparing() {
  seedStore((state) => ({
    ...state,
    lobby: {
      ...state.lobby,
      status: "connected",
      join: { type: "preparing", payload: { phase: "downloading", detail: "setons_clutch.zip", progress: 40 } },
    },
  }));
  render(<JoinPreparationDialog />);
}

describe("JoinPreparationDialog, mounted", () => {
  it("narrates the preparation and cancels with one cancelJoin, closing only once the backend confirms", async () => {
    const user = userEvent.setup();
    mountPreparing();

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByRole("heading", { name: "Getting the game ready" })).toBeDefined();
    expect(screen.getByText("Downloading what is missing")).toBeDefined();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");

    await user.click(screen.getByRole("button", { name: "Cancel joining" }));
    expect(sentCommands()).toEqual([{ kind: "Lobby", command: { type: "cancelJoin" } }]);
    // Still the backend's join until it says otherwise.
    expect(screen.getByRole("dialog")).toBeDefined();

    lobby({ type: "joinCancelled" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays closed when a refusal for the cancelled join, or a second confirmation, arrives late", async () => {
    const user = userEvent.setup();
    mountPreparing();
    await user.click(screen.getByRole("button", { name: "Cancel joining" }));
    lobby({ type: "joinCancelled" });

    lobby({ type: "joinFailed", payload: { id: GAME_ID, reason: "Game is closed" } });
    expect(screen.queryByRole("dialog")).toBeNull();
    lobby({ type: "joinCancelled" });
    expect(screen.queryByRole("dialog")).toBeNull();
    lobby({ type: "gameTerminated" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sentCommands()).toHaveLength(1);
  });

  it("reopens on a progress frame that arrives after the cancel, because a frame names no join", async () => {
    // Current behaviour, recorded: the dialog follows `lobby.join`, and the
    // reducer takes every `preparing` frame as the current join's. Keeping a
    // stale frame out is the backend's to guarantee, and it does: preparation
    // checks the cancel at each step boundary, which
    // `crates/faf-app/tests/launch_preparation.rs` holds it to.
    const user = userEvent.setup();
    mountPreparing();
    await user.click(screen.getByRole("button", { name: "Cancel joining" }));
    lobby({ type: "joinCancelled" });

    progress("setons_clutch.zip", 60);
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("sends cancelJoin again on a quick second click, because the button stays until the backend answers", async () => {
    // Current behaviour, recorded rather than fixed. The second finds nothing
    // left to call off, and the reducer ignores the `joinCancelled` it
    // answers with once the join is idle.
    const user = userEvent.setup();
    mountPreparing();

    await user.dblClick(screen.getByRole("button", { name: "Cancel joining" }));
    expect(sentCommands()).toEqual([
      { kind: "Lobby", command: { type: "cancelJoin" } },
      { kind: "Lobby", command: { type: "cancelJoin" } },
    ]);
  });

  it("hides without cancelling, stays hidden while the same join carries on, and shows the next join again", async () => {
    const user = userEvent.setup();
    mountPreparing();

    await user.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sentCommands()).toEqual([]);

    // The request is still in flight; its later answers land on a closed
    // dialog and leave it closed.
    progress("setons_clutch.zip", 80);
    lobby({ type: "launching", payload: { launch: LAUNCH } });
    expect(screen.queryByRole("dialog")).toBeNull();
    lobby({ type: "inGame" });
    expect(screen.queryByRole("dialog")).toBeNull();

    // A different join later is a fresh dialog.
    lobby({ type: "gameTerminated" });
    progress("faf_patch", 10);
    expect(screen.getByRole("dialog")).toBeDefined();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("10");
  });

  it("hides on Escape and sends nothing", async () => {
    const user = userEvent.setup();
    mountPreparing();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sentCommands()).toEqual([]);
  });

  it("keeps the dialog through the launch as Starting the game, where the same command stops the game", async () => {
    const user = userEvent.setup();
    mountPreparing();

    lobby({ type: "launching", payload: { launch: LAUNCH } });
    expect(screen.getByRole("heading", { name: "Starting the game" })).toBeDefined();
    expect(screen.getByText(/Friday Setons/)).toBeDefined();

    await user.click(screen.getByRole("button", { name: "Stop the game" }));
    expect(sentCommands()).toEqual([{ kind: "Lobby", command: { type: "cancelJoin" } }]);

    // The backend's word that the game was stopped removes the dialog.
    lobby({ type: "gameTerminated" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
