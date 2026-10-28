// @vitest-environment happy-dom

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ChangelogSearchState } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { ChangelogView } from "./ChangelogView";
import { ChangelogBlockView } from "../../shared/components/ChangelogBlocks";

vi.mock("../../ipc/client");
vi.mock("../../shared/components/ChangelogBlocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/components/ChangelogBlocks")>();
  return { ...actual, ChangelogBlockView: vi.fn(actual.ChangelogBlockView) };
});
failOnConsoleError();

function mountArchive() {
  seedStore(state => ({ ...state, changelog: { ...state.changelog,
    status: { type: "ready" }, entryStatus: { type: "ready" }, selected: "3822",
    releases: ["3822", "3818"].map(id => ({ id, kind: "Game Patch", date: "2025-05-19", year: "2025",
      sourceUrl: `https://example.invalid/${id}`, webUrl: `https://example.invalid/${id}` })),
    entries: { "3822": { id: "3822", title: "Game version 3822", blocks: [
      { type: "paragraph", payload: { spans: [{ type: "text", payload: "The current note stays open." }] } },
    ] } },
  } }));
  render(<ChangelogView />);
  clearSentCommands();
}

function update(search: Partial<ChangelogSearchState>) {
  applyEvent({ kind: "Changelog", event: { type: "searchUpdated", payload: { search: {
    requestId: 5, query: "Cooper", status: { type: "loading" }, scanned: 8, total: 171, failed: 0, matches: [], ...search,
  } } } });
}

it("does not redraw the open patch for archive progress or results", () => {
  mountArchive();
  const block = vi.mocked(ChangelogBlockView);
  block.mockClear();
  for (let scanned = 1; scanned <= 171; scanned += 8) {
    update({ scanned, matches: [{ releaseId: "3818", blockPath: [0], excerpt: "Cooper changes", occurrences: scanned }] });
  }
  update({ scanned: 171, status: { type: "ready" } });
  expect(screen.getByText("The current note stays open.")).toBeTruthy();
  expect(block).not.toHaveBeenCalled();
});

it("keeps native Ctrl+F and provides an additional top-right search submitted explicitly", async () => {
  const user = userEvent.setup();
  mountArchive();
  const find = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
  fireEvent(window, find);
  expect(find.defaultPrevented).toBe(false);
  expect(screen.queryByRole("dialog")).toBeNull();
  const button = screen.getByRole("button", { name: en["changelog.archive.open"] });
  expect(button.closest(".changelog-subnav")).toBeTruthy();
  await user.click(button);
  const dialog = within(screen.getByRole("dialog", { name: en["changelog.archive.open"] }));
  await user.type(dialog.getByRole("searchbox"), "Cooper");
  expect(sentCommands()).toEqual([]);
  await user.keyboard("{Enter}");
  expect(sentCommands()).toEqual([{ kind: "Changelog", command: { type: "search", payload: { query: "Cooper" } } }]);
  update({});
  expect(dialog.getByText("Searching patches: 8 / 171")).toBeTruthy();
  update({ requestId: 4, query: "stale" });
  expect(dialog.queryByText("Results for “stale”")).toBeNull();
  update({ status: { type: "ready" }, scanned: 171, matches: [
    { releaseId: "3818", blockPath: [1], excerpt: "Cooper torpedo changes", occurrences: 2 },
  ] });
  expect(dialog.getByText("Matching patches: 1")).toBeTruthy();
  expect(dialog.getByRole("button", { name: /3818/ }).querySelector("mark")?.textContent).toBe("Cooper");
  clearSentCommands();
  await user.click(dialog.getByRole("button", { name: /3818/ }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sentCommands()).toEqual([
    { kind: "Nav", command: { type: "selectChangelogSection", payload: { section: "game" } } },
    { kind: "Changelog", command: { type: "select", payload: { id: "3818" } } },
  ]);
});

it("cancels an unfinished archive scan when the shared dialog closes", async () => {
  const user = userEvent.setup();
  mountArchive();
  await user.click(screen.getByRole("button", { name: en["changelog.archive.open"] }));
  update({});
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(sentCommands()).toEqual([{ kind: "Changelog", command: { type: "search", payload: { query: "" } } }]);
  expect(screen.getByText("The current note stays open.")).toBeTruthy();
});

it("reports incomplete scans and failures with a retry, and highlights literal punctuation safely", async () => {
  const user = userEvent.setup();
  mountArchive();
  await user.click(screen.getByRole("button", { name: en["changelog.archive.open"] }));
  const dialog = within(screen.getByRole("dialog"));
  update({ query: "[C++]", status: { type: "ready" }, scanned: 171, failed: 1, matches: [
    { releaseId: "3818", blockPath: [0], excerpt: "A literal [C++] description", occurrences: 1 },
  ] });
  expect(dialog.getByRole("button", { name: /3818/ }).querySelector("mark")?.textContent).toBe("[C++]");
  expect(dialog.getByText("Incomplete patch notes: 1. Search again to retry.")).toBeTruthy();
  update({ status: { type: "failed", payload: { reason: "temporary source failure" } } });
  clearSentCommands();
  await user.click(within(dialog.getByRole("alert")).getByRole("button", { name: en["changelog.archive.submit"] }));
  expect(sentCommands()).toEqual([{ kind: "Changelog", command: { type: "search", payload: { query: "Cooper" } } }]);
});
