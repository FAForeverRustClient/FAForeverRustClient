// @vitest-environment happy-dom
//
// The update banner while the installer downloads: its bar's Cancel sends the
// backend's cancel, and the offer it comes back to is the backend's to say.
// Its "What's new" opens the release in the client's own changelog when the
// notes have been read, and the release page when they have not.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientReleaseNotes } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { UpdateBanner } from "./UpdateBanner";

vi.mock("../../ipc/client");

failOnConsoleError();

const release = {
  version: "0.9.0",
  notesUrl: "",
  downloadUrl: "https://example.invalid/installer.exe",
  assetName: "installer.exe",
  sizeBytes: 100,
  preRelease: false,
  publishedAt: "",
};

describe("UpdateBanner, downloading", () => {
  it("cancels the download from beside its bar, and offers it again once called off", async () => {
    const user = userEvent.setup();
    seedStore((state) => ({
      ...state,
      settings: { ...state.settings, updates: { ...state.settings.updates, automatic: true } },
      clientUpdate: {
        ...state.clientUpdate,
        release,
        status: { type: "downloading", payload: { receivedBytes: 25, totalBytes: 100 } },
      },
    }));
    render(<UpdateBanner />);
    clearSentCommands();

    await user.click(screen.getByRole("button", { name: "Cancel download" }));
    expect(sentCommands()).toEqual([{ kind: "ClientUpdate", command: { type: "cancelDownload" } }]);

    applyEvent({ kind: "ClientUpdate", event: { type: "downloadCancelled" } });
    expect(screen.queryByRole("button", { name: "Cancel download" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download update" })).toHaveProperty("disabled", false);
  });
});

describe("UpdateBanner, What's new", () => {
  const notesUrl = "https://github.com/example/client/releases/tag/v0.9.0";
  const notes: ClientReleaseNotes = {
    version: "0.9.0",
    publishedAt: "2026-09-01T12:00:00Z",
    preRelease: false,
    notesUrl,
    blocks: [],
  };

  /** An offer of 0.9.0 with a release page, and the notes read so far. */
  function seedOffer(read: ClientReleaseNotes[]) {
    seedStore((state) => ({
      ...state,
      settings: { ...state.settings, updates: { ...state.settings.updates, automatic: true } },
      clientUpdate: {
        ...state.clientUpdate,
        release: { ...release, notesUrl },
        status: { type: "available" },
        notes: read,
        notesStatus: { type: "ready" },
      },
    }));
  }

  // Only the page opener: the console guard has a spy of its own.
  const spyOnOpen = () => vi.spyOn(window, "open").mockReturnValue(null);
  let open: ReturnType<typeof spyOnOpen> | null = null;
  afterEach(() => {
    open?.mockRestore();
    open = null;
  });

  it("opens the release in the client's changelog when its notes have been read", async () => {
    const user = userEvent.setup();
    open = spyOnOpen();
    seedOffer([notes]);
    render(<UpdateBanner />);
    clearSentCommands();

    await user.click(screen.getByRole("button", { name: en["updates.whatsNew"] }));
    expect(sentCommands()).toEqual([
      { kind: "Nav", command: { type: "select", payload: { tab: "changelog" } } },
      { kind: "Nav", command: { type: "selectChangelogClientRelease", payload: { version: "0.9.0" } } },
    ]);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens the release page when the client has not read its notes", async () => {
    const user = userEvent.setup();
    open = spyOnOpen();
    seedOffer([{ ...notes, version: "0.8.0" }]);
    render(<UpdateBanner />);
    clearSentCommands();

    await user.click(screen.getByRole("button", { name: en["updates.whatsNew"] }));
    expect(open).toHaveBeenCalledWith(notesUrl, "_blank", "noopener,noreferrer");
    expect(sentCommands()).toEqual([]);
  });
});
