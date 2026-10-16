// @vitest-environment happy-dom
//
// The What's new popup after an update, mounted against the store. It waits
// for the notes and for a game to end, and is never shown in place of notes
// that could not be read; it lists every change in the release, the
// highlights first, each section under its heading; both of its ways out
// record it as seen. A release with nothing to list is recorded as seen
// without being shown.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppState, ChangelogListItem, ClientReleaseNotes } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { WhatsNewDialog } from "./WhatsNewDialog";

vi.mock("../../ipc/client");

failOnConsoleError();

const DISMISS = { kind: "ClientUpdate", command: { type: "dismissWhatsNew" } };

const item = (text: string): ChangelogListItem => ({
  spans: [{ type: "text", payload: text }],
  change: null,
  children: [],
});

/** Four features and three fixes: seven changes, in the notes' order. */
const RELEASE: ClientReleaseNotes = {
  version: "0.5.0",
  publishedAt: "2026-09-01T12:00:00Z",
  preRelease: true,
  notesUrl: "https://github.com/example/client/releases/tag/v0.5.0",
  blocks: [
    { type: "heading", payload: { level: 3, text: "Features" } },
    { type: "list", payload: { items: [item("Feature one"), item("Feature two"), item("Feature three"), item("Feature four")] } },
    { type: "heading", payload: { level: 3, text: "Bug fixes" } },
    { type: "list", payload: { items: [item("Fix one"), item("Fix two"), item("Fix three")] } },
  ],
};

/** The first start after the update to 0.5.0, the notes in `notesStatus`. */
function seedWhatsNew(clientUpdate: Partial<AppState["clientUpdate"]>, build: (state: AppState) => AppState = (state) => state) {
  seedStore((state) =>
    build({
      ...state,
      clientUpdate: { ...state.clientUpdate, currentVersion: "0.5.0", whatsNew: "0.5.0", ...clientUpdate },
    }),
  );
}

describe("What's new popup, mounted", () => {
  it("waits for the notes, then lists every change under its section", () => {
    seedWhatsNew({ notesStatus: { type: "loading" } });
    render(<WhatsNewDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sentCommands()).toEqual([]);

    applyEvent({ kind: "ClientUpdate", event: { type: "notesLoaded", payload: { notes: [RELEASE] } } });
    const dialog = screen.getByRole("dialog", { name: "What's new in v0.5.0" });
    const changes = within(dialog).getAllByRole("listitem").map((element) => element.textContent);
    expect(changes).toEqual(["Feature one", "Feature two", "Feature three", "Feature four", "Fix one", "Fix two", "Fix three"]);
    const headings = within(dialog).getAllByRole("heading", { level: 3 }).map((element) => element.textContent);
    expect(headings).toEqual(["Features", "Bug fixes"]);
    // Enter closes it rather than following a link in the list.
    const closes = within(dialog).getAllByRole("button", { name: en["common.close"] });
    expect(document.activeElement).toBe(closes[closes.length - 1]);
    expect(sentCommands()).toEqual([]);
  });

  it("lists the release's highlights first, then every other change", () => {
    const highlighted: ClientReleaseNotes = {
      ...RELEASE,
      blocks: [
        { type: "heading", payload: { level: 3, text: "Highlights" } },
        { type: "list", payload: { items: [item("The headline"), item("The other headline")] } },
        ...RELEASE.blocks,
      ],
    };
    seedWhatsNew({ notes: [highlighted], notesStatus: { type: "ready" } });
    render(<WhatsNewDialog />);

    const dialog = screen.getByRole("dialog", { name: "What's new in v0.5.0" });
    const changes = within(dialog).getAllByRole("listitem").map((element) => element.textContent);
    expect(changes).toEqual([
      "The headline",
      "The other headline",
      "Feature one",
      "Feature two",
      "Feature three",
      "Feature four",
      "Fix one",
      "Fix two",
      "Fix three",
    ]);
    const headings = within(dialog).getAllByRole("heading", { level: 3 }).map((element) => element.textContent);
    expect(headings).toEqual(["Highlights", "Features", "Bug fixes"]);
  });

  it("records the popup as seen from Close", async () => {
    const user = userEvent.setup();
    seedWhatsNew({ notes: [RELEASE], notesStatus: { type: "ready" } });
    render(<WhatsNewDialog />);

    const dialog = screen.getByRole("dialog");
    // The dialog's own close button comes first; this is the one in its row.
    const buttons = within(dialog).getAllByRole("button", { name: en["common.close"] });
    await user.click(buttons[buttons.length - 1]);
    expect(sentCommands()).toEqual([DISMISS]);
  });

  it("records it as seen from Escape too", async () => {
    const user = userEvent.setup();
    seedWhatsNew({ notes: [RELEASE], notesStatus: { type: "ready" } });
    render(<WhatsNewDialog />);

    await user.keyboard("{Escape}");
    expect(sentCommands()).toEqual([DISMISS]);
  });

  it("records a release with nothing to list as seen without showing anything", () => {
    const prose: ClientReleaseNotes = {
      ...RELEASE,
      blocks: [{ type: "paragraph", payload: { spans: [{ type: "text", payload: "Maintenance release." }] } }],
    };
    seedWhatsNew({ notes: [prose], notesStatus: { type: "ready" } });
    render(<WhatsNewDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sentCommands()).toEqual([DISMISS]);
  });

  it("records a version missing from the notes as seen without showing anything", () => {
    seedWhatsNew({ notes: [{ ...RELEASE, version: "0.4.0" }], notesStatus: { type: "ready" } });
    render(<WhatsNewDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sentCommands()).toEqual([DISMISS]);
  });

  it("shows nothing and records nothing when the notes could not be read", () => {
    seedWhatsNew({ notesStatus: { type: "failed", payload: { reason: "github unreachable" } } });
    render(<WhatsNewDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sentCommands()).toEqual([]);
  });

  it("waits while a game runs, and comes up once it is over", () => {
    seedWhatsNew({ notes: [RELEASE], notesStatus: { type: "ready" } }, (state) => ({
      ...state,
      lobby: { ...state.lobby, join: { type: "inGame" } },
    }));
    render(<WhatsNewDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(sentCommands()).toEqual([]);

    act(() => {
      seedWhatsNew({ notes: [RELEASE], notesStatus: { type: "ready" } });
    });
    expect(screen.getByRole("dialog", { name: "What's new in v0.5.0" })).toBeTruthy();
    clearSentCommands();
  });
});
