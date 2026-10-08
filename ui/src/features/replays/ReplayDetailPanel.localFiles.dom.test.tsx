// @vitest-environment happy-dom
//
// Two replay files from the local library whose headers name no game, opened
// one after the other the way the library opens them. Both are uid 0, and the
// panel used to name its reads by uid alone: the second file's insights found
// the first one's analysis already there, drew it as its own and never asked
// for its own. These hold that each file asks for, and shows, only its own
// reads, wherever the other file's answers and failures land in between.
//
// Also here, because they are about the same files: one file reached through
// two spellings of its path is one read, a file without a game id keeps a note
// on its path, and the panel asks again for its details if the store's cap
// drops them while they are on screen.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  AppCommand,
  LocalReplay,
  ReplayAnalysis,
  ReplayDetails,
  ReplayEvent,
  ReplayNote,
} from "../../ipc/bindings";
import { replayReadKey } from "../../shared/rules/replayReadKey";
import { REPLAY_DETAILS_KEPT } from "../../store/reducers/replays";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { ReplayDetailPanel, localReplayToVaultReplay } from "./ReplayDetailPanel";

vi.mock("../../ipc/client");

failOnConsoleError();

function skirmish(name: string): LocalReplay {
  return {
    path: `C:/replays/${name}.fafreplay`,
    fileName: `${name}.fafreplay`,
    uid: null,
    map: "scmp_009",
    modName: "faf",
    title: `Skirmish ${name}`,
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

const fileA = skirmish("a");
const fileB = skirmish("b");

/** What the backend names this file's reads: it has no game id, so its path. */
const readOf = (file: LocalReplay) => replayReadKey(file.uid ?? 0, file.path);

function detailsOf(file: LocalReplay): ReplayDetails {
  return { gameOptions: [{ key: "MapSeed", value: `seed of ${file.title}` }], chatMessages: [], gameVersion: null };
}

function analysisOf(file: LocalReplay): ReplayAnalysis {
  return {
    uid: 0,
    key: readOf(file),
    ticks: 3_000,
    gameVersion: "",
    armies: [],
    observers: [],
    scenario: { name: "", description: "", mapFolder: "", width: 0, height: 0, options: [] },
    activity: [],
    orders: [],
    points: [],
    notices: [{ tick: 600, source: 0, text: `upgrade in ${file.title}` }],
    stats: [],
  };
}

const replayEvent = (event: ReplayEvent) => applyEvent({ kind: "Replays", event });

/** The read commands sent since the last clear. */
function reads(): AppCommand[] {
  return sentCommands().filter(
    (command) =>
      command.kind === "Replays"
      && (command.command.type === "loadDetails" || command.command.type === "loadAnalysis"),
  );
}

function readsFor(file: LocalReplay): AppCommand[] {
  const payload = { uid: 0, localPath: file.path };
  return [
    { kind: "Replays", command: { type: "loadDetails", payload } },
    { kind: "Replays", command: { type: "loadAnalysis", payload } },
  ];
}

/** The panel the local library opens on a file, as `LocalReplayView` mounts it. */
function mountFile(file: LocalReplay) {
  return render(
    <ReplayDetailPanel
      replay={localReplayToVaultReplay(file, [])}
      busy={false}
      source="local"
      localPath={file.path}
      onClose={() => undefined}
      onWatch={() => undefined}
    />,
  );
}

async function openInsights(user: ReturnType<typeof userEvent.setup>, file: LocalReplay) {
  const panel = screen.getByRole("dialog", { name: `Replay ${file.title}` });
  await user.click(within(panel).getByRole("button", { name: "More info" }));
  return screen.getByRole("dialog", { name: `What the replay file says about ${file.title}` });
}

/** Everything both reads of one file answer. */
function answer(file: LocalReplay) {
  replayEvent({ type: "detailsLoading", payload: { key: readOf(file) } });
  replayEvent({ type: "analysisLoading", payload: { key: readOf(file) } });
  replayEvent({ type: "detailsLoaded", payload: { key: readOf(file), details: detailsOf(file) } });
  replayEvent({ type: "analysisLoaded", payload: { analysis: analysisOf(file) } });
}

describe("Two local replay files without a game id", () => {
  it("asks for the second file's own reads and shows only its answers", async () => {
    const user = userEvent.setup();
    const first = mountFile(fileA);
    clearSentCommands();
    let insights = await openInsights(user, fileA);
    expect(reads()).toEqual(readsFor(fileA));
    answer(fileA);
    expect(within(insights).getByText(`seed of ${fileA.title}`)).toBeTruthy();
    first.unmount();

    mountFile(fileB);
    clearSentCommands();
    insights = await openInsights(user, fileB);
    // Both reads, the analysis included: the first file's analysis was
    // never this one's.
    expect(reads()).toEqual(readsFor(fileB));
    expect(within(insights).queryByText(`seed of ${fileA.title}`)).toBeNull();
    await user.click(within(insights).getByRole("tab", { name: /^Events/ }));
    expect(within(insights).queryByText(`upgrade in ${fileA.title}`)).toBeNull();

    replayEvent({ type: "detailsLoading", payload: { key: readOf(fileB) } });
    replayEvent({ type: "analysisLoading", payload: { key: readOf(fileB) } });
    // The first file answering again, late, lands nowhere this panel draws.
    replayEvent({ type: "analysisLoaded", payload: { analysis: analysisOf(fileA) } });
    expect(within(insights).queryByText(`upgrade in ${fileA.title}`)).toBeNull();

    replayEvent({ type: "detailsLoaded", payload: { key: readOf(fileB), details: detailsOf(fileB) } });
    replayEvent({ type: "analysisLoaded", payload: { analysis: analysisOf(fileB) } });
    expect(within(insights).getByText(`upgrade in ${fileB.title}`)).toBeTruthy();
    await user.click(within(insights).getByRole("tab", { name: /^Game Options/ }));
    expect(within(insights).getByText(`seed of ${fileB.title}`)).toBeTruthy();
    expect(within(insights).queryByText(`seed of ${fileA.title}`)).toBeNull();
  });

  it("keeps each file's failure to that file", async () => {
    const user = userEvent.setup();
    const first = mountFile(fileA);
    await openInsights(user, fileA);
    replayEvent({ type: "detailsLoading", payload: { key: readOf(fileA) } });
    replayEvent({ type: "analysisLoading", payload: { key: readOf(fileA) } });
    first.unmount();

    mountFile(fileB);
    const insights = await openInsights(user, fileB);
    replayEvent({ type: "detailsLoading", payload: { key: readOf(fileB) } });
    replayEvent({ type: "analysisLoading", payload: { key: readOf(fileB) } });

    // The first file's reads fail while the second one is open.
    replayEvent({ type: "detailsFailed", payload: { key: readOf(fileA), reason: "A is truncated" } });
    replayEvent({ type: "analysisFailed", payload: { key: readOf(fileA), reason: "A is truncated" } });
    expect(screen.queryAllByText("A is truncated.")).toEqual([]);

    // Its own failure is its own to show.
    replayEvent({ type: "detailsFailed", payload: { key: readOf(fileB), reason: "B is truncated" } });
    expect(within(insights).getAllByText("B is truncated.").length).toBeGreaterThan(0);
  });
});

describe("One file without a game id, reached through another spelling of its path", () => {
  it("is not read again", async () => {
    const user = userEvent.setup();
    const first = mountFile(fileA);
    await openInsights(user, fileA);
    answer(fileA);
    first.unmount();

    // The same file as the shell hands it over: backslashes, other case.
    const sameFile = { ...fileA, path: "C:\\Replays\\A.fafreplay" };
    mountFile(sameFile);
    clearSentCommands();
    const insights = await openInsights(user, sameFile);
    expect(reads()).toEqual([]);
    expect(within(insights).getByText(`seed of ${fileA.title}`)).toBeTruthy();
  });
});

describe("A file opened through another spelling of its library path", () => {
  it("still finds its library entry and draws the lineup the file recorded", () => {
    // The library's scan knows who played; the copy the shell hands over, by
    // a double-click or a file association, is spelt differently and carries
    // no lineup of its own.
    const scanned: LocalReplay = {
      ...fileA,
      teams: [{ team: "1", players: [{ name: "AI: Rufus", faction: 1, rating: null, ai: true }] }],
    };
    seedStore((state) => ({ ...state, replays: { ...state.replays, local: [scanned] } }));
    const opened = { ...fileA, path: "C:\\Replays\\A.fafreplay" };
    mountFile(opened);

    const panel = screen.getByRole("dialog", { name: `Replay ${fileA.title}` });
    expect(within(panel).getByText("AI: Rufus")).toBeTruthy();
  });
});

describe("A note on a file without a game id", () => {
  const settingsChanged = (replayNotes: ReplayNote[]) =>
    applyEvent({
      kind: "Settings",
      event: { type: "socialChanged", payload: { preferences: { playerNotes: [], replayNotes } } },
    });

  it("is written on the file and shown again on it, however its path is spelt", async () => {
    const user = userEvent.setup();
    const first = mountFile(fileA);
    const panel = screen.getByRole("dialog", { name: `Replay ${fileA.title}` });
    clearSentCommands();
    await user.click(within(panel).getByRole("button", { name: "Notes and tags" }));
    const notes = screen.getByRole("dialog", { name: "Your notes" });
    await user.type(within(notes).getByRole("textbox", { name: "Comment" }), "vs two hard AIs");
    await user.click(within(notes).getByRole("button", { name: "Save" }));
    expect(sentCommands()).toEqual([
      {
        kind: "Settings",
        command: {
          type: "setReplayNote",
          payload: { replayId: 0, localPath: fileA.path, comment: "vs two hard AIs", tags: [] },
        },
      },
    ]);

    // As the backend answers it: kept on the file's normalised path.
    settingsChanged([{ replayId: 0, path: "c:/replays/a.fafreplay", comment: "vs two hard AIs", tags: [] }]);
    expect(within(panel).getByRole("button", { name: "Notes and tags" }).className).toContain("is-on");
    first.unmount();

    // The other file has no note, and this one's is there through another spelling.
    const other = mountFile(fileB);
    const otherPanel = screen.getByRole("dialog", { name: `Replay ${fileB.title}` });
    expect(within(otherPanel).getByRole("button", { name: "Notes and tags" }).className).not.toContain("is-on");
    other.unmount();

    const sameFile = { ...fileA, path: "C:\\Replays\\A.fafreplay" };
    mountFile(sameFile);
    const samePanel = screen.getByRole("dialog", { name: `Replay ${fileA.title}` });
    await user.click(within(samePanel).getByRole("button", { name: "Notes and tags" }));
    const reopened = screen.getByRole("dialog", { name: "Your notes" });
    expect(within(reopened).getByRole("textbox", { name: "Comment" })).toHaveProperty("value", "vs two hard AIs");
  });
});

describe("A file's details dropped by the store's cap while on screen", () => {
  it("are asked for again", async () => {
    const user = userEvent.setup();
    mountFile(fileA);
    const insights = await openInsights(user, fileA);
    answer(fileA);
    expect(within(insights).getByText(`seed of ${fileA.title}`)).toBeTruthy();
    clearSentCommands();

    // Other reads finishing while this panel is open, enough to push its own
    // entry out of the store.
    for (let uid = 1; uid <= REPLAY_DETAILS_KEPT; uid += 1) {
      replayEvent({ type: "detailsLoaded", payload: { key: replayReadKey(uid, null), details: detailsOf(fileB) } });
    }
    expect(reads()).toEqual([readsFor(fileA)[0]]);

    replayEvent({ type: "detailsLoading", payload: { key: readOf(fileA) } });
    replayEvent({ type: "detailsLoaded", payload: { key: readOf(fileA), details: detailsOf(fileA) } });
    expect(within(insights).getByText(`seed of ${fileA.title}`)).toBeTruthy();
    // And once is enough: the answer is stored as the newest.
    expect(reads()).toEqual([readsFor(fileA)[0]]);
  });
});
