// @vitest-environment happy-dom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalReplay } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, seedStore } from "../../testing/mounted";
import { localReplayToVaultReplay, ReplayDetailPanel } from "./ReplayDetailPanel";

const shell = vi.hoisted(() => ({ revealReplay: vi.fn<(path: string) => Promise<void>>() }));
vi.mock("../../ipc/client");
vi.mock("../../ipc/native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ipc/native")>();
  return { ...actual, native: { ...actual.native, revealReplay: shell.revealReplay } };
});

failOnConsoleError();
beforeEach(() => { shell.revealReplay.mockReset().mockResolvedValue(); });

const file: LocalReplay = {
  path: "C:/replays/4242.fafreplay", fileName: "4242.fafreplay", uid: 4242,
  title: "Ladder night", map: "scmp_009", modName: "faf", recorder: "",
  startTime: null, durationSeconds: null, modifiedTime: 0, fileSizeBytes: 1024,
  numPlayers: 2, teams: [], averageRating: null, simMods: [], status: "complete",
  watchable: true, gameVersion: null,
};

function mount(source: "local" | "online" = "online", localFile = file) {
  return render(<ReplayDetailPanel
    replay={localReplayToVaultReplay(localFile, [])}
    source={source}
    localPath={source === "local" ? localFile.path : undefined}
    busy={false}
    onClose={vi.fn()}
    onWatch={vi.fn()}
  />);
}

describe("Show in Explorer from a replay card", () => {
  it("reveals a local file without an ID and sits between Notes and tags and More info", async () => {
    const user = userEvent.setup();
    mount("local", { ...file, uid: null });
    const reveal = screen.getByRole("button", { name: "Show in Explorer" });
    const toolbar = reveal.parentElement;
    if (!toolbar) throw new Error("no replay toolbar");
    const names = within(toolbar).getAllByRole("button").map((button) => button.textContent);
    const index = names.indexOf("Show in Explorer");
    expect(names.slice(index - 1, index + 2)).toEqual(["Notes and tags", "Show in Explorer", "More info"]);
    await user.click(reveal);
    expect(shell.revealReplay.mock.calls).toEqual([[file.path]]);
  });

  it("uses the matching local file when opening a replay from the online vault", async () => {
    const user = userEvent.setup();
    seedStore((state) => ({ ...state, replays: { ...state.replays, local: [
      { ...file, uid: 5151, path: "C:/replays/5151.fafreplay" }, file,
    ] } }));
    mount();
    await user.click(screen.getByRole("button", { name: "Show in Explorer" }));
    expect(shell.revealReplay.mock.calls).toEqual([[file.path]]);
  });

  it("has no file action for an online replay without a local copy", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Show in Explorer" })).toBeNull();
    expect(shell.revealReplay).not.toHaveBeenCalled();
  });

  it("appears after a download finishes and disappears if the local copy is removed", async () => {
    const user = userEvent.setup();
    mount();
    expect(screen.queryByRole("button", { name: "Show in Explorer" })).toBeNull();
    applyEvent({ kind: "Replays", event: { type: "vaultDownloaded", payload: { uid: 4242, replay: file } } });
    await user.click(screen.getByRole("button", { name: "Show in Explorer" }));
    expect(shell.revealReplay.mock.calls).toEqual([[file.path]]);
    applyEvent({ kind: "Replays", event: { type: "localDeleted", payload: { path: file.path } } });
    expect(screen.queryByRole("button", { name: "Show in Explorer" })).toBeNull();
  });
});
