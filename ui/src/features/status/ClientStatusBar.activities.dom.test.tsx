// @vitest-environment happy-dom
//
// The status bar's task slot for background work, mounted and driven by the
// backend's events the way the app drives it: each long-running operation
// shows what it is doing, how far along it is when the backend measures it,
// and a Cancel that sends the backend's own cancel command where the work can
// be stopped. Work that cannot be stopped half-way (a removal, a publish whose
// last byte is out) offers none.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppEvent } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, sentCommands } from "../../testing/mounted";
import { ClientStatusBar } from "./ClientStatusBar";

vi.mock("../../ipc/client");

failOnConsoleError();

const apply = (...events: AppEvent[]) => events.forEach(applyEvent);

/** The task slot's bar, by the name it gives the work. */
const bar = (name: string) => screen.getByRole("progressbar", { name });

describe("ClientStatusBar background activities", () => {
  it("shows a map install's download measured, and calls it off from the bar", async () => {
    const user = userEvent.setup();
    render(<ClientStatusBar />);
    apply(
      { kind: "Maps", event: { type: "installing", payload: { folderName: "setons_clutch.v0003" } } },
      {
        kind: "Maps",
        event: { type: "installProgressed", payload: { folderName: "setons_clutch.v0003", progress: 55 } },
      },
    );

    expect(bar("Installing map setons_clutch.v0003").getAttribute("aria-valuenow")).toBe("55");
    expect(screen.getByText("55%")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Cancel: Installing map setons_clutch.v0003" }));
    expect(sentCommands()).toEqual([
      { kind: "Maps", command: { type: "cancelInstall", payload: { folderName: "setons_clutch.v0003" } } },
    ]);

    // The backend's answer ends the task without a failure.
    apply({ kind: "Maps", event: { type: "installCancelled", payload: { folderName: "setons_clutch.v0003" } } });
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("sweeps again while the archive unpacks, and offers no Cancel for a removal", () => {
    render(<ClientStatusBar />);
    apply(
      {
        kind: "Maps",
        event: { type: "installedLoaded", payload: { maps: [{ folderName: "old.v0001", displayName: "Old" }] } },
      },
      { kind: "Maps", event: { type: "installing", payload: { folderName: "old.v0001" } } },
    );

    expect(bar("Removing map old.v0001").getAttribute("data-indeterminate")).toBe("true");
    expect(screen.queryByRole("button", { name: /^Cancel: / })).toBeNull();
  });

  it("narrates a replay starting with its measured step, and cancels the watch", async () => {
    const user = userEvent.setup();
    render(<ClientStatusBar />);
    apply(
      { kind: "Replays", event: { type: "connecting" } },
      {
        kind: "Replays",
        event: { type: "preparing", payload: { step: { detail: "Downloading replay 42", progress: 30 } } },
      },
    );

    const label = "Starting replay: Downloading replay 42";
    expect(bar(label).getAttribute("aria-valuenow")).toBe("30");
    await user.click(screen.getByRole("button", { name: `Cancel: ${label}` }));
    expect(sentCommands()).toEqual([{ kind: "Replays", command: { type: "cancelWatch" } }]);
  });

  it("measures a download into the library and cancels that download alone", async () => {
    const user = userEvent.setup();
    render(<ClientStatusBar />);
    apply(
      { kind: "Replays", event: { type: "vaultDownloadStarted", payload: { uid: 42 } } },
      { kind: "Replays", event: { type: "vaultDownloadProgressed", payload: { uid: 42, progress: 20 } } },
    );

    expect(bar("Downloading replay 42").getAttribute("aria-valuenow")).toBe("20");
    await user.click(screen.getByRole("button", { name: "Cancel: Downloading replay 42" }));
    expect(sentCommands()).toEqual([
      { kind: "Replays", command: { type: "cancelDownload", payload: { uid: 42 } } },
    ]);
  });

  it("cancels a mod install, the map generator and the client update from their own lines", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<ClientStatusBar />);
    apply(
      { kind: "Mods", event: { type: "installing", payload: { uid: "abc-123" } } },
      { kind: "Mods", event: { type: "installProgressed", payload: { uid: "abc-123", progress: 70 } } },
    );
    expect(bar("Installing mod abc-123").getAttribute("aria-valuenow")).toBe("70");
    await user.click(screen.getByRole("button", { name: "Cancel: Installing mod abc-123" }));
    apply({ kind: "Mods", event: { type: "installCancelled", payload: { uid: "abc-123" } } });

    apply({ kind: "MapGenerator", event: { type: "statusChanged", payload: { status: { type: "generating", payload: { version: "1.8.5", detail: "" } } } } });
    await user.click(screen.getByRole("button", { name: "Cancel: Generating map…" }));
    apply({ kind: "MapGenerator", event: { type: "statusChanged", payload: { status: { type: "cancelled" } } } });

    apply(
      {
        kind: "ClientUpdate",
        event: {
          type: "available",
          payload: {
            release: {
              version: "0.9.0",
              notesUrl: "",
              downloadUrl: "https://example.invalid/installer.exe",
              assetName: "installer.exe",
              sizeBytes: 100,
              preRelease: false,
              publishedAt: "",
            },
          },
        },
      },
      { kind: "ClientUpdate", event: { type: "downloadProgressed", payload: { receivedBytes: 25, totalBytes: 100 } } },
    );
    expect(bar("Downloading client update 0.9.0").getAttribute("aria-valuenow")).toBe("25");
    await user.click(screen.getByRole("button", { name: "Cancel: Downloading client update 0.9.0" }));

    expect(sentCommands()).toEqual([
      { kind: "Mods", command: { type: "cancelInstall", payload: { uid: "abc-123" } } },
      { kind: "MapGenerator", command: { type: "cancel" } },
      { kind: "ClientUpdate", command: { type: "cancelDownload" } },
    ]);
    unmount();
  });

  it("offers a hidden publish's Cancel only while bytes are still going out", async () => {
    const user = userEvent.setup();
    render(<ClientStatusBar />);
    apply({
      kind: "Uploads",
      event: { type: "progressed", payload: { status: { type: "uploading", payload: { sentBytes: 50, totalBytes: 100 } } } },
    });

    expect(bar("Publishing to the vault").getAttribute("aria-valuenow")).toBe("50");
    await user.click(screen.getByRole("button", { name: "Cancel: Publishing to the vault" }));
    expect(sentCommands()).toEqual([{ kind: "Uploads", command: { type: "cancel" } }]);

    // Every byte is out: the vault decides from here, so there is nothing to stop.
    apply({
      kind: "Uploads",
      event: { type: "progressed", payload: { status: { type: "uploading", payload: { sentBytes: 100, totalBytes: 100 } } } },
    });
    expect(screen.queryByRole("button", { name: "Cancel: Publishing to the vault" })).toBeNull();
  });

  it("shows the first task with its own Cancel and names the rest on hover", () => {
    render(<ClientStatusBar />);
    apply(
      { kind: "Replays", event: { type: "vaultDownloadStarted", payload: { uid: 42 } } },
      { kind: "Maps", event: { type: "vaultSearching" } },
      { kind: "Mods", event: { type: "vaultSearching" } },
    );

    const more = screen.getByText("+2");
    expect(more.getAttribute("title")).toBe(
      "Downloading replay 42. Also running: Searching the map vault…, Searching the mod vault…",
    );
    expect(screen.getByRole("button", { name: "Cancel: Downloading replay 42" })).toBeTruthy();
  });
});
