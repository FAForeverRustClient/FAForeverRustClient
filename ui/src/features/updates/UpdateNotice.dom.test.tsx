// @vitest-environment happy-dom
//
// The sidebar update notice in each state, and what each one sends; its
// popover's focus, Escape and "Not now"; the release page for a platform with
// no installer; the gate rising only once an update is overdue; Cancel while
// the installer downloads, and the offer the backend brings back; and "What's
// new", in the client's own changelog when the notes have been read, on the
// release page when they have not.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientReleaseNotes } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { UpdateNotice } from "./UpdateNotice";
import { UpdateGate } from "./UpdateGate";
import { UpdatesSettingsSection } from "../settings/UpdatesSettingsSection";

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

describe("UpdateNotice states", () => {
  it.each([
    ["available", "Update available"],
    ["downloading", "Downloading…"],
    ["ready", "Install update"],
    ["installing", "Close the client to finish"],
    ["failed", "Update failed"],
  ] as const)("shows %s and dispatches its action", async (type, label) => {
    const user = userEvent.setup();
    const status = type === "ready" ? { type, payload: { path: "installer" } } as const
      : type === "failed" ? { type, payload: { reason: "Connection reset" } } as const
        : type === "downloading" ? { type, payload: { receivedBytes: 42, totalBytes: 100 } } as const
          : { type };
    seedStore((state) => ({ ...state, clientUpdate: { ...state.clientUpdate, release, overdue: false, status } }));
    render(<div className="app-shell is-sidebar-rail"><UpdateNotice /></div>);
    const pill = screen.getByRole("button", { name: label });
    expect(pill.getAttribute("title")).toBe(type === "downloading" ? "Downloading 42%" : label);
    clearSentCommands();
    await user.click(pill);
    if (type === "ready") {
      expect(sentCommands()).toEqual([{ kind: "ClientUpdate", command: { type: "install" } }]);
    } else {
      expect(screen.getByRole("dialog")).toBeDefined();
      if (type !== "installing") {
        await user.click(screen.getByRole("button", { name: type === "failed" ? "Try again" : type === "downloading" ? "Cancel download" : "Download update" }));
        expect(sentCommands()).toEqual([{ kind: "ClientUpdate", command: { type: type === "downloading" ? "cancelDownload" : "download" } }]);
      }
    }
  });

  it("dismisses this version and restores focus after Escape", async () => {
    const user = userEvent.setup();
    seedStore((state) => ({ ...state, clientUpdate: { ...state.clientUpdate, release, status: { type: "available" } } }));
    render(<UpdateNotice />);
    const pill = screen.getByRole("button", { name: "Update available" });
    await user.click(pill);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Not now" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(pill);
    await user.click(pill);
    clearSentCommands();
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(sentCommands()).toEqual([{ kind: "ClientUpdate", command: { type: "dismiss" } }]);
    applyEvent({ kind: "ClientUpdate", event: { type: "dismissed", payload: { version: release.version } } });
    expect(screen.queryByRole("button", { name: "Update available" })).toBeNull();
  });

  it("opens the release page when there is no installer", async () => {
    const user = userEvent.setup();
    seedStore((state) => ({ ...state, clientUpdate: { ...state.clientUpdate,
      release: { ...release, downloadUrl: "", notesUrl: "https://example.invalid/releases/0.9.0" }, status: { type: "available" } } }));
    render(<UpdateNotice />);
    await user.click(screen.getByRole("button", { name: "Update available" }));
    expect(screen.getByRole("button", { name: "Open the release page" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Download update" })).toBeNull();
  });

  it("only raises the gate after overdue and keeps a deferred notice accessible", () => {
    seedStore((state) => ({ ...state, clientUpdate: { ...state.clientUpdate, release, overdue: false, status: { type: "available" } } }));
    const view = render(<><UpdateNotice /><UpdateGate /></>);
    expect(screen.queryByRole("dialog")).toBeNull();
    applyEvent({ kind: "ClientUpdate", event: { type: "overdue" } });
    expect(screen.getByRole("dialog", { name: "Update required" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Update available" })).toBeNull();
    view.rerender(<><UpdateNotice deferredVersion={release.version} /><UpdateGate deferredVersion={release.version} /></>);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Update available" })).toBeDefined();
  });

  it("patches only background downloads from Settings", async () => {
    const user = userEvent.setup();
    render(<UpdatesSettingsSection />);
    clearSentCommands();
    await user.click(screen.getByRole("checkbox", { name: "Download updates in the background" }));
    expect(sentCommands()).toEqual([{ kind: "Settings", command: { type: "patchUpdates", payload: { patch: { backgroundDownload: true } } } }]);
  });
});

describe("UpdateNotice, downloading", () => {
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
    render(<UpdateNotice />);
    clearSentCommands();
    await user.click(screen.getByRole("button", { name: /Update available|Downloading/ }));

    await user.click(screen.getByRole("button", { name: "Cancel download" }));
    expect(sentCommands()).toEqual([{ kind: "ClientUpdate", command: { type: "cancelDownload" } }]);

    applyEvent({ kind: "ClientUpdate", event: { type: "downloadCancelled" } });
    expect(screen.queryByRole("button", { name: "Cancel download" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download update" })).toHaveProperty("disabled", false);
  });
});

describe("UpdateNotice, What's new", () => {
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
    render(<UpdateNotice />);
    clearSentCommands();
    await user.click(screen.getByRole("button", { name: /Update available|Downloading/ }));

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
    render(<UpdateNotice />);
    clearSentCommands();
    await user.click(screen.getByRole("button", { name: /Update available|Downloading/ }));

    await user.click(screen.getByRole("button", { name: en["updates.whatsNew"] }));
    expect(open).toHaveBeenCalledWith(notesUrl, "_blank", "noopener,noreferrer");
    expect(sentCommands()).toEqual([]);
  });
});
