// @vitest-environment happy-dom
//
// The online replay tab, mounted from the workspace down, so the detail panel
// gets its download state and its busy flag from the store the way the app
// gives them. A download goes out, the backend's answers move the panel along,
// and watching sends one command and closes the panel. A request still in
// flight when the panel closes answers into nothing, and a failed search or
// download offers the way to try again.
//
// Double clicks: the panel's Watch is safe because the panel closes on the
// first click, and the card's own double click watches once. The card's Watch
// button and the panel's Download are not guarded in the view: both send a
// second command until the backend's first answer disables them, and the tests
// below record that rather than hide it.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppCommand, LocalReplay, ReplayEvent, VaultReplay } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import { ReplaysView } from "./ReplaysView";

vi.mock("../../ipc/client");

failOnConsoleError();

function vaultReplay(uid: number, title: string): VaultReplay {
  return {
    uid,
    title,
    map: "scmp_009",
    mapThumbnailUrl: "",
    modName: "faf",
    startTime: "2026-01-02T18:00:00Z",
    replayAvailable: true,
    durationSeconds: 1_200,
    gameDurationSeconds: 1_100,
    teams: [],
    averageRating: 1_500,
    quality: 80,
    reviewsAverage: null,
    reviewsCount: null,
    gameVersion: null,
  };
}

const ladder = vaultReplay(4242, "Ladder night");
const team = vaultReplay(5151, "Team game");

function downloadedFile(uid: number): LocalReplay {
  return {
    path: `C:/replays/${uid}.fafreplay`,
    fileName: `${uid}.fafreplay`,
    uid,
    map: "scmp_009",
    modName: "faf",
    title: "Ladder night",
    recorder: "",
    startTime: null,
    durationSeconds: null,
    modifiedTime: 0,
    fileSizeBytes: 1_024,
    numPlayers: 2,
    teams: [],
    averageRating: null,
    simMods: [],
    status: "complete",
    watchable: true,
    gameVersion: null,
  };
}

const replayEvent = (event: ReplayEvent) => applyEvent({ kind: "Replays", event });

const watchVault = (uid: number): AppCommand => ({ kind: "Replays", command: { type: "watchVault", payload: { uid } } });
const downloadVault = (uid: number): AppCommand => ({
  kind: "Replays",
  command: { type: "downloadVault", payload: { uid } },
});

/** The commands of one kind and type sent since the last clear. */
function sent(type: string): AppCommand[] {
  return sentCommands().filter((command) => command.kind === "Replays" && command.command.type === type);
}

/**
 * The Replays workspace on its Online source, with a vault page already on
 * screen. The commands the tab sends as it opens are cleared, so a test reads
 * only what its own clicks sent.
 */
function mountVault(vault: VaultReplay[] = [ladder, team]) {
  seedStore((state) => ({
    ...state,
    replays: { ...state.replays, vault, vaultStatus: { type: "ready" }, vaultQuery: EMPTY_REPLAY_QUERY },
  }));
  const view = render(<ReplaysView />);
  clearSentCommands();
  return view;
}

const panel = (title: string) => screen.getByRole("dialog", { name: `Replay ${title}` });
const queryPanel = (title: string) => screen.queryByRole("dialog", { name: `Replay ${title}` });

async function openCard(user: ReturnType<typeof userEvent.setup>, title: string) {
  await user.click(screen.getByText(title));
  return panel(title);
}

describe("Replay detail flows, mounted from the Replays workspace", () => {
  it("downloads, follows the backend's answers, then watches with one command and closes", async () => {
    const user = userEvent.setup();
    mountVault();
    const dialog = await openCard(user, "Ladder night");

    await user.click(within(dialog).getByRole("button", { name: "Download" }));
    expect(sent("downloadVault")).toEqual([downloadVault(4242)]);

    replayEvent({ type: "vaultDownloadStarted", payload: { uid: 4242 } });
    const busyButton = within(dialog).getByRole("button", { name: "Downloading…" });
    expect(busyButton).toHaveProperty("disabled", true);

    replayEvent({ type: "vaultDownloaded", payload: { uid: 4242, replay: downloadedFile(4242) } });
    expect(within(dialog).getByRole("button", { name: "Downloaded" })).toHaveProperty("disabled", true);

    clearSentCommands();
    await user.click(within(dialog).getByRole("button", { name: "Watch" }));
    expect(sent("watchVault")).toEqual([watchVault(4242)]);
    expect(queryPanel("Ladder night")).toBeNull();
  });

  it("shows another replay's download as nothing of its own", async () => {
    const user = userEvent.setup();
    mountVault();
    replayEvent({ type: "vaultDownloadStarted", payload: { uid: 5151 } });

    const dialog = await openCard(user, "Ladder night");
    expect(within(dialog).getByRole("button", { name: "Download" })).toHaveProperty("disabled", false);
  });

  it("sends one watch for a double click on the panel's Watch, because the panel closes on the first", async () => {
    const user = userEvent.setup();
    mountVault();
    const dialog = await openCard(user, "Ladder night");
    clearSentCommands();

    await user.dblClick(within(dialog).getByRole("button", { name: "Watch" }));
    expect(sent("watchVault")).toEqual([watchVault(4242)]);
    expect(queryPanel("Ladder night")).toBeNull();
  });

  it("watches once on a double click of the card itself", async () => {
    const user = userEvent.setup();
    mountVault();

    await user.dblClick(screen.getByText("Team game"));
    expect(sent("watchVault")).toEqual([watchVault(5151)]);
  });

  it("does not guard the card's Watch button: a double click sends two watches until the backend says it is starting", async () => {
    const user = userEvent.setup();
    mountVault();
    const watch = screen.getByRole("button", { name: "Watch Team game" });

    await user.dblClick(watch);
    // Unguarded in the view: `busy` comes from the backend's `connecting`,
    // which has not arrived between two clicks of one double click.
    expect(sent("watchVault")).toEqual([watchVault(5151), watchVault(5151)]);

    replayEvent({ type: "connecting" });
    expect(watch).toHaveProperty("disabled", true);
    clearSentCommands();
    await user.dblClick(watch);
    expect(sent("watchVault")).toEqual([]);
  });

  it("does not guard Download either: a double click sends two downloads until the backend's first answer", async () => {
    const user = userEvent.setup();
    mountVault();
    const dialog = await openCard(user, "Ladder night");
    const download = within(dialog).getByRole("button", { name: "Download" });

    await user.dblClick(download);
    expect(sent("downloadVault")).toEqual([downloadVault(4242), downloadVault(4242)]);

    replayEvent({ type: "vaultDownloadStarted", payload: { uid: 4242 } });
    clearSentCommands();
    await user.dblClick(within(dialog).getByRole("button", { name: "Downloading…" }));
    expect(sent("downloadVault")).toEqual([]);
  });

  it("disables Watch while another replay is starting and gives it back when the start fails", async () => {
    const user = userEvent.setup();
    mountVault();
    const dialog = await openCard(user, "Ladder night");
    const watch = within(dialog).getByRole("button", { name: "Watch" });

    replayEvent({ type: "connecting" });
    expect(watch).toHaveProperty("disabled", true);
    await user.click(watch);
    expect(sent("watchVault")).toEqual([]);

    replayEvent({ type: "failed", payload: { reason: "game exited" } });
    expect(watch).toHaveProperty("disabled", false);
  });

  it("says why a download failed and sends it again from the same button", async () => {
    const user = userEvent.setup();
    mountVault();
    const dialog = await openCard(user, "Ladder night");

    await user.click(within(dialog).getByRole("button", { name: "Download" }));
    replayEvent({ type: "vaultDownloadStarted", payload: { uid: 4242 } });
    replayEvent({ type: "vaultDownloadFailed", payload: { uid: 4242, reason: "disk full" } });

    expect(within(dialog).getByText("Could not download replay: disk full")).toBeTruthy();
    clearSentCommands();
    await user.click(within(dialog).getByRole("button", { name: "Download" }));
    expect(sent("downloadVault")).toEqual([downloadVault(4242)]);
  });

  it("lets a download finish after its panel was closed, and shows it done on reopening", async () => {
    const user = userEvent.setup();
    mountVault();
    const dialog = await openCard(user, "Ladder night");
    await user.click(within(dialog).getByRole("button", { name: "Download" }));
    replayEvent({ type: "vaultDownloadStarted", payload: { uid: 4242 } });

    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[0]);
    expect(queryPanel("Ladder night")).toBeNull();

    replayEvent({ type: "vaultDownloaded", payload: { uid: 4242, replay: downloadedFile(4242) } });
    expect(queryPanel("Ladder night")).toBeNull();

    const reopened = await openCard(user, "Ladder night");
    expect(within(reopened).getByRole("button", { name: "Downloaded" })).toHaveProperty("disabled", true);
  });

  it("takes the late answers to the insights it asked for without reopening or complaining", async () => {
    const user = userEvent.setup();
    mountVault();
    const dialog = await openCard(user, "Ladder night");
    clearSentCommands();

    await user.click(within(dialog).getByRole("button", { name: "More info" }));
    expect(sent("loadDetails").length + sent("loadAnalysis").length).toBe(2);
    replayEvent({ type: "detailsLoading", payload: { uid: 4242 } });
    replayEvent({ type: "analysisLoading", payload: { uid: 4242 } });

    await user.keyboard("{Escape}");
    await user.keyboard("{Escape}");
    expect(queryPanel("Ladder night")).toBeNull();

    replayEvent({ type: "detailsFailed", payload: { uid: 4242, reason: "file gone" } });
    replayEvent({ type: "analysisFailed", payload: { uid: 4242, reason: "file gone" } });
    expect(screen.queryAllByRole("dialog")).toEqual([]);
  });

  it("offers Retry on a failed vault search and sends the same search again", async () => {
    const user = userEvent.setup();
    mountVault();
    replayEvent({ type: "vaultLoadFailed", payload: { reason: "HTTP 503" } });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not load vault");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(sent("searchVault")).toEqual([
      { kind: "Replays", command: { type: "searchVault", payload: { query: EMPTY_REPLAY_QUERY } } },
    ]);

    replayEvent({ type: "vaultLoading" });
    replayEvent({
      type: "vaultLoaded",
      payload: { replays: [team], query: EMPTY_REPLAY_QUERY, hasMore: false, totalPages: 1, totalRecords: 1 },
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Team game")).toBeTruthy();
    expect(screen.queryByText("Ladder night")).toBeNull();
  });
});
