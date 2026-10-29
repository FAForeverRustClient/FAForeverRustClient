// @vitest-environment happy-dom
//
// The changelog's two failures, mounted against the store: the release list
// that did not load, and one patch note that did not. Each says what happened
// in a plain sentence rather than as the HTTP client's English, keeps that
// English on hover for a bug report, and asks for the same thing again from
// its button.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ChangelogEvent, ChangelogRelease } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, sentCommands } from "../../testing/mounted";
import { ChangelogView } from "./ChangelogView";

vi.mock("../../ipc/client");

failOnConsoleError();

const changelogEvent = (event: ChangelogEvent) => applyEvent({ kind: "Changelog", event });

const patch: ChangelogRelease = {
  id: "3837",
  kind: "Game Patch",
  date: "2026-05-15",
  year: "2026",
  sourceUrl: "https://raw.githubusercontent.com/FAForever/fa/develop/changelog/3837.md",
  webUrl: "https://faforever.github.io/fa/changelog/3837",
};

/** The view as it opens, with the load it sent on mounting set aside. */
function mountChangelog() {
  render(<ChangelogView />);
  expect(sentCommands()).toEqual([{ kind: "Changelog", command: { type: "load" } }]);
  clearSentCommands();
}

describe("Changelog failures, mounted", () => {
  it("keeps undated and unverified legacy notes separate from rolling branches", async () => {
    const user = userEvent.setup();
    mountChangelog();
    const undated = { ...patch, id: "3616", kind: "Historical FAF patch", date: "", year: "" };
    const legacy = { ...patch, id: "legacy-3605", kind: "Legacy notes", date: "", year: "" };
    const beta = { ...patch, id: "fafbeta", kind: "FAF Beta", date: "", year: "" };
    changelogEvent({ type: "loaded", payload: { releases: [beta, patch, undated, legacy] } });
    await user.click(screen.getByRole("button", { name: /Undated FAF notes/ }));
    await user.click(screen.getByRole("button", { name: /Legacy notes/ }));
    expect(document.querySelector('[data-release-id="3616"]')?.closest("section")?.id).not.toBe("branches");
    expect(document.querySelector('[data-release-id="3616"]')?.closest("ul")?.id).toBe("changelog-group-undated");
    expect(document.querySelector('[data-release-id="legacy-3605"]')?.textContent).toContain("3605");
    expect(document.querySelector('[data-release-id="legacy-3605"]')?.textContent).not.toContain("legacy-");
    expect(document.querySelector('[data-release-id="fafbeta"]')?.closest("ul")?.id).toBe("changelog-group-branches");
    changelogEvent({ type: "entryLoaded", payload: { entry: { id: undated.id, title: "Patch 3616", blocks: [] } } });
    const article = screen.getByRole("article");
    expect(within(article).getByText("Release date unverified")).toBeTruthy();
    expect(article.querySelector("time")).toBeNull();
    expect(within(article).getByRole("button", { name: "Next note" })).toBeTruthy();
  });

  it("says a release list that did not load plainly, with the reason on hover, and loads it again", async () => {
    const user = userEvent.setup();
    mountChangelog();
    const reason = "error sending request for url (https://api.github.com/repos/FAForever/fa/contents/changelog)";
    changelogEvent({ type: "loadFailed", payload: { reason } });

    expect(screen.getByText(en["changelog.failed.title"])).toBeTruthy();
    expect(screen.getByText(en["errors.cause.offline"]).getAttribute("title")).toBe(reason);
    expect(screen.queryByText(reason)).toBeNull();

    await user.click(screen.getByRole("button", { name: en["changelog.retry"] }));
    expect(sentCommands()).toEqual([{ kind: "Changelog", command: { type: "load" } }]);
  });

  it("says a note that did not load in a notice whose button asks for that note again", async () => {
    const user = userEvent.setup();
    mountChangelog();
    changelogEvent({ type: "loaded", payload: { releases: [patch] } });
    changelogEvent({ type: "entryLoading", payload: { id: patch.id } });
    const reason = "HTTP 404 Not Found for https://raw.githubusercontent.com/FAForever/fa/develop/changelog/3837.md";
    changelogEvent({ type: "entryLoadFailed", payload: { reason } });

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(en["errors.cause.notFound"]).getAttribute("title")).toBe(reason);
    expect(alert.textContent).not.toContain("HTTP 404");

    await user.click(within(alert).getByRole("button", { name: en["changelog.retry"] }));
    expect(sentCommands()).toEqual([{ kind: "Changelog", command: { type: "select", payload: { id: patch.id } } }]);

    // The note arriving takes the failure down.
    changelogEvent({ type: "entryLoaded", payload: { entry: { id: patch.id, title: "Game version 3837", blocks: [] } } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
