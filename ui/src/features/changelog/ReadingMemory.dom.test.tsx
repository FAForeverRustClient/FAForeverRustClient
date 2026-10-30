// @vitest-environment happy-dom

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChangelogBlock, ChangelogEntry, ChangelogRelease } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, seedStore } from "../../testing/mounted";
import { ChangelogView } from "./ChangelogView";
import { anchorFor } from "./noteReader";
import { changelogViewMemory } from "./viewMemory";

vi.mock("../../ipc/client");
failOnConsoleError();

const blocks: ChangelogBlock[] = [
  { type: "heading", payload: { level: 1, text: "Game version 3810" } },
  { type: "heading", payload: { level: 2, text: "Balance" } },
  { type: "paragraph", payload: { spans: [{ type: "text", payload: "Published unit changes." }] } },
  { type: "heading", payload: { level: 2, text: "Contributors" } },
];
const entry = (id: string): ChangelogEntry => ({ id, title: id, blocks: blocks.map((block, index) =>
  index === 0 ? { type: "heading", payload: { level: 1, text: `Game version ${id}` } } : block) });
const release = (id: string, date: string): ChangelogRelease => ({
  id, date, year: date.slice(0, 4), kind: "Game Patch", sourceUrl: `https://example.invalid/${id}.md`, webUrl: `https://example.invalid/${id}`,
});
let releaseRowTop = 140;

beforeEach(() => {
  releaseRowTop = 140;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.id === anchorFor(3)) return new DOMRect(0, 1200, 700, 32);
    return this.classList.contains("changelog-release")
      ? new DOMRect(0, releaseRowTop, 250, 32) : new DOMRect(0, 100, 700, 600);
  });
  for (const memory of Object.values(changelogViewMemory)) {
    memory.position = null;
    memory.listTop = 0;
    memory.years = new Set();
  }
  seedStore(state => ({ ...state,
    changelog: { ...state.changelog, status: { type: "ready" }, entryStatus: { type: "ready" },
      releases: [release("3837", "2026-05-15"), release("3810", "2024-10-01")],
      selected: "3810", entries: { "3810": entry("3810"), "3837": entry("3837") } },
    nav: { ...state.nav, changelogSection: "game", changelogClientVersion: "0.4.0" },
    clientUpdate: { ...state.clientUpdate, notesStatus: { type: "ready" }, notes: [{
      version: "0.4.0", publishedAt: "2026-09-01T12:00:00Z", preRelease: false,
      notesUrl: "https://example.invalid/client", blocks: blocks.slice(1),
    }] },
  }));
});

function pane(): HTMLDivElement {
  return document.querySelector<HTMLDivElement>(".changelog-note-scroll")!;
}

function scrollTo(top: number) {
  const scroll = pane();
  Object.defineProperties(scroll, {
    scrollHeight: { configurable: true, value: 2500 },
    clientHeight: { configurable: true, value: 400 },
  });
  scroll.scrollTop = top;
  fireEvent.scroll(scroll);
}

it("restores the open game note, reading offset, release-list offset and expanded year after a tab unmount", () => {
  const first = render(<ChangelogView />);
  const year = document.querySelector<HTMLButtonElement>('[aria-controls="changelog-group-2024"]')!;
  expect(year.getAttribute("aria-expanded")).toBe("true");
  const list = document.querySelector<HTMLElement>(".changelog-releases")!;
  list.scrollTop = 180;
  fireEvent.scroll(list);
  scrollTo(720);
  first.unmount();
  // The reader browsed the list away from the selected row. Returning should
  // retain that list offset too, rather than forcing the selection into view.
  releaseRowTop = -300;
  render(<ChangelogView />);
  expect(screen.getByRole("heading", { level: 1, name: "Game version 3810" })).toBeTruthy();
  expect(pane().scrollTop).toBe(720);
  expect(document.querySelector<HTMLElement>(".changelog-releases")!.scrollTop).toBe(180);
  expect(document.querySelector('[aria-controls="changelog-group-2024"]')?.getAttribute("aria-expanded")).toBe("true");
});

it("opens a folded year when a search result chooses an old patch", () => {
  applyEvent({ kind: "Changelog", event: { type: "entryLoaded", payload: { entry: entry("3837") } } });
  render(<ChangelogView />);
  const year = document.querySelector('[aria-controls="changelog-group-2024"]')!;
  expect(year.getAttribute("aria-expanded")).toBe("false");
  applyEvent({ kind: "Changelog", event: { type: "entryLoaded", payload: { entry: entry("3810") } } });
  expect(year.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[data-release-id="3810"]')?.closest("ul")?.hidden).toBe(false);
});

it("keeps the selected year open when a temporary patch filter is cleared", async () => {
  const user = userEvent.setup();
  applyEvent({ kind: "Changelog", event: { type: "entryLoaded", payload: { entry: entry("3837") } } });
  render(<ChangelogView />);
  const filter = screen.getByRole("searchbox", { name: en["changelog.searchAria"] });
  await user.type(filter, "3810");
  applyEvent({ kind: "Changelog", event: { type: "entryLoaded", payload: { entry: entry("3810") } } });
  await user.clear(filter);
  expect(document.querySelector('[aria-controls="changelog-group-2024"]')?.getAttribute("aria-expanded")).toBe("true");
  expect(document.querySelector('[data-release-id="3810"]')?.closest("ul")?.hidden).toBe(false);
});

it("preserves a manually folded selected year when returning to the same note", async () => {
  const user = userEvent.setup();
  const first = render(<ChangelogView />);
  await user.click(document.querySelector<HTMLButtonElement>('[aria-controls="changelog-group-2024"]')!);
  first.unmount();
  render(<ChangelogView />);
  expect(document.querySelector('[aria-controls="changelog-group-2024"]')?.getAttribute("aria-expanded")).toBe("false");
});

it.each([
  ["3616", "Historical FAF patch", "undated"],
  ["legacy-3605", "Legacy notes", "legacy"],
])("reveals a selected %s note in its folded historical group", (id, kind, group) => {
  const historical = { ...release(id, ""), kind };
  seedStore(state => ({ ...state, changelog: { ...state.changelog,
    status: { type: "ready" }, entryStatus: { type: "ready" },
    selected: "3837", releases: [release("3837", "2026-05-15"), historical], entries: { "3837": entry("3837") },
  } }));
  render(<ChangelogView />);
  applyEvent({ kind: "Changelog", event: { type: "entryLoaded", payload: { entry: entry(id) } } });
  expect(document.querySelector(`[aria-controls="changelog-group-${group}"]`)?.getAttribute("aria-expanded")).toBe("true");
});

it("keeps game and client reading positions independent when switching sections", () => {
  render(<ChangelogView />);
  scrollTo(720);
  applyEvent({ kind: "Nav", event: { type: "changelogSectionSelected", payload: { section: "client" } } });
  expect(pane().scrollTop).toBe(0);
  scrollTo(350);
  applyEvent({ kind: "Nav", event: { type: "changelogSectionSelected", payload: { section: "game" } } });
  expect(pane().scrollTop).toBe(720);
  applyEvent({ kind: "Nav", event: { type: "changelogSectionSelected", payload: { section: "client" } } });
  expect(pane().scrollTop).toBe(350);
  expect(screen.getByRole("heading", { level: 1, name: "FAForever Client v0.4.0" })).toBeTruthy();
});

it("preserves position during a note refresh and starts a different note at the top", () => {
  render(<ChangelogView />);
  scrollTo(640);
  applyEvent({ kind: "Changelog", event: { type: "entryLoaded", payload: { entry: entry("3810") } } });
  expect(pane().scrollTop).toBe(640);
  applyEvent({ kind: "Changelog", event: { type: "entryLoaded", payload: { entry: entry("3837") } } });
  expect(pane().scrollTop).toBe(0);
});

it("waits for the remembered note's content before restoring and retains its active contents entry", () => {
  changelogViewMemory.game.position = { selection: "3810", top: 610, section: anchorFor(1) };
  seedStore(state => ({ ...state, changelog: { ...state.changelog,
    selected: "3810", status: { type: "ready" }, entryStatus: { type: "loading", payload: { id: "3810" } },
    releases: [release("3810", "2024-10-01")], entries: {},
  } }));
  render(<ChangelogView />);
  applyEvent({ kind: "Changelog", event: { type: "entryLoaded", payload: { entry: entry("3810") } } });
  expect(pane().scrollTop).toBe(610);
  const nav = document.querySelector<HTMLElement>(".changelog-toc")!;
  expect(nav.getAttribute("aria-label")).toBe(en["changelog.contents"]);
  expect(within(nav).getByRole("button", { name: "Balance" }).getAttribute("aria-current")).toBe("location");
});
