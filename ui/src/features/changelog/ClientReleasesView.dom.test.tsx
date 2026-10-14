// @vitest-environment happy-dom
//
// The Changelog tab's client section, mounted against the store: the tab
// switch asks the backend for the section, the list says which release is
// running, which is on offer and which are pre-releases, picking a row asks
// for that release, a release published without notes says so, and a list
// that did not load asks for it again.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppState, ClientReleaseNotes } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { ChangelogView } from "./ChangelogView";

vi.mock("../../ipc/client");

failOnConsoleError();

const release = (version: string, preRelease: boolean, blocks: ClientReleaseNotes["blocks"]): ClientReleaseNotes => ({
  version,
  publishedAt: "2026-09-01T12:00:00Z",
  preRelease,
  notesUrl: `https://github.com/example/client/releases/tag/v${version}`,
  blocks,
});

const features: ClientReleaseNotes["blocks"] = [
  { type: "heading", payload: { level: 3, text: "Features" } },
  {
    type: "list",
    payload: {
      items: [{ spans: [{ type: "text", payload: "Replays can be filtered by map." }], change: null, children: [] }],
    },
  },
];

const NOTES = [
  release("0.5.0", true, features),
  release("0.4.0", true, features),
  // Published before the changelog snippets: nothing but the installer line,
  // which the parser drops.
  release("0.3.0", false, []),
];

/** The tab on its client section, with the running build and an offer. */
function seedClientSection(build: (state: AppState) => AppState = (state) => state) {
  seedStore((state) =>
    build({
      ...state,
      nav: { ...state.nav, changelogSection: "client" },
      clientUpdate: {
        ...state.clientUpdate,
        currentVersion: "0.4.0",
        status: { type: "available" },
        release: {
          version: "0.5.0",
          notesUrl: "https://github.com/example/client/releases/tag/v0.5.0",
          downloadUrl: "https://example.invalid/installer.exe",
          assetName: "installer.exe",
          sizeBytes: 100,
          preRelease: true,
          publishedAt: "2026-09-01T12:00:00Z",
        },
        notes: NOTES,
        notesStatus: { type: "ready" },
      },
    }),
  );
}

const releaseList = () => screen.getByRole("navigation", { name: en["changelog.client.releases"] });
const row = (version: string) => within(releaseList()).getByRole("button", { name: new RegExp(`^v${version.replace(/\./g, "\\.")}`) });

describe("Changelog client section, mounted", () => {
  it("asks for the client section from its tab, and reads the notes once it is open", async () => {
    const user = userEvent.setup();
    render(<ChangelogView />);
    clearSentCommands();

    await user.click(screen.getByRole("tab", { name: en["changelog.section.client"] }));
    expect(sentCommands()).toEqual([
      { kind: "Nav", command: { type: "selectChangelogSection", payload: { section: "client" } } },
    ]);

    clearSentCommands();
    applyEvent({ kind: "Nav", event: { type: "changelogSectionSelected", payload: { section: "client" } } });
    expect(screen.getByRole("tab", { name: en["changelog.section.client"] }).getAttribute("aria-selected")).toBe("true");
    expect(sentCommands()).toEqual([{ kind: "ClientUpdate", command: { type: "loadNotes" } }]);
  });

  it("tags the release on offer, the one running and the pre-releases, and opens on the newest", () => {
    seedClientSection();
    render(<ChangelogView />);

    const offered = row("0.5.0");
    expect(within(offered).getByText(en["changelog.client.updateAvailable"])).toBeTruthy();
    expect(within(offered).getByText(en["changelog.client.preRelease"])).toBeTruthy();
    expect(within(offered).queryByText(en["changelog.client.installed"])).toBeNull();
    expect(offered.getAttribute("aria-current")).toBe("page");

    const running = row("0.4.0");
    expect(within(running).getByText(en["changelog.client.installed"])).toBeTruthy();
    expect(within(running).getByText(en["changelog.client.preRelease"])).toBeTruthy();
    expect(within(running).queryByText(en["changelog.client.updateAvailable"])).toBeNull();

    const stable = row("0.3.0");
    expect(within(stable).queryByText(en["changelog.client.installed"])).toBeNull();
    expect(within(stable).queryByText(en["changelog.client.updateAvailable"])).toBeNull();
    expect(within(stable).queryByText(en["changelog.client.preRelease"])).toBeNull();

    // The newest release's note, its category as a section of it.
    expect(screen.getByRole("heading", { level: 1, name: "FAForever Client v0.5.0" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "Features" })).toBeTruthy();
    expect(screen.getByText("Replays can be filtered by map.")).toBeTruthy();
  });

  it("asks for the release picked, and says plainly that a release has no notes", async () => {
    const user = userEvent.setup();
    seedClientSection();
    render(<ChangelogView />);
    clearSentCommands();

    await user.click(row("0.3.0"));
    expect(sentCommands()).toEqual([
      { kind: "Nav", command: { type: "selectChangelogClientRelease", payload: { version: "0.3.0" } } },
    ]);

    applyEvent({ kind: "Nav", event: { type: "changelogClientReleaseSelected", payload: { version: "0.3.0" } } });
    expect(screen.getByRole("heading", { level: 1, name: "FAForever Client v0.3.0" })).toBeTruthy();
    expect(screen.getByText(en["changelog.client.noNotes"])).toBeTruthy();
    expect(screen.getAllByRole("button", { name: en["changelog.client.openOnGithub"] }).length).toBeGreaterThan(0);
  });

  it("says a list that did not load plainly, with the reason on hover, and asks for it again", async () => {
    const user = userEvent.setup();
    const reason = "error sending request for url (https://api.github.com/repos/example/client/releases)";
    seedClientSection((state) => ({
      ...state,
      clientUpdate: { ...state.clientUpdate, notes: [], notesStatus: { type: "failed", payload: { reason } } },
    }));
    render(<ChangelogView />);
    clearSentCommands();

    expect(screen.getByText(en["changelog.client.failed.title"])).toBeTruthy();
    expect(screen.getByText(en["errors.cause.offline"]).getAttribute("title")).toBe(reason);

    await user.click(screen.getByRole("button", { name: en["changelog.retry"] }));
    expect(sentCommands()).toEqual([{ kind: "ClientUpdate", command: { type: "loadNotes" } }]);
  });

  it("finds a release by the words of its notes", async () => {
    const user = userEvent.setup();
    seedClientSection();
    render(<ChangelogView />);

    await user.type(screen.getByRole("searchbox", { name: en["changelog.client.searchAria"] }), "filtered by map");
    expect(row("0.5.0")).toBeTruthy();
    expect(row("0.4.0")).toBeTruthy();
    expect(within(releaseList()).queryByRole("button", { name: /^v0\.3\.0/ })).toBeNull();
  });
});
