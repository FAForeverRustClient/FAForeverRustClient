// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { CachedGameVersion, ChangelogRelease } from "../../ipc/bindings";
import { GameCacheSettingsSection } from "./GameCacheSettingsSection";
import { applyEvent, seedStore, sentCommands } from "../../testing/mounted";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";

const shell = vi.hoisted(() => ({ openVersionFolder: vi.fn(), openUrl: vi.fn() }));
vi.mock("../../ipc/native", () => ({ native: shell }));
vi.mock("../../ipc/client");
failOnConsoleError();

const version = (number: number): CachedGameVersion => ({ name: `FAF Build ${number}`, version: number, url: `https://github.com/FAForever/fa/releases/tag/${number}`, fileCount: 4, sizeBytes: 1000 });
const release = (id: string, date = ""): ChangelogRelease => ({ id, date, kind: "Hotfix", year: date.slice(0, 4), sourceUrl: `https://patchnotes.faforever.com/${id}`, webUrl: `https://patchnotes.faforever.com/${id}` });
const development: CachedGameVersion = { ...version(3840), name: "FAF Develop (c7d9d12)", url: "https://github.com/FAForever/fa/commit/c7d9d12" };

/** The cached build's line in the list, where its release date is shown. */
const line = (name: string) => screen.getByText(name).closest("li")!;

function seed(versions: CachedGameVersion[], releases: ChangelogRelease[], ready = true) {
  seedStore(state => ({ ...state, settings: { ...state.settings, cacheInfo: { totalFiles: 12, totalSizeBytes: 3000, versions } },
    changelog: { ...state.changelog, releases, status: ready ? { type: "ready" } : { type: "idle" }, selected: "3839" },
  }));
}

it("shows each cached build's verified release date and preserves folder/link actions", async () => {
  seed([version(3840), version(3839), development], [release("3840", "2026-10-20"), release("3839")]);
  render(<GameCacheSettingsSection />);
  const folder = screen.getByText("FAF Build 3840").closest("button")!;
  const external = screen.getByRole("button", { name: en["settings.game.openReleaseNotes"].replace("{name}", "FAF Build 3840") });
  expect(line("FAF Build 3840").textContent).toContain("Released: October 20, 2026");
  expect(line("FAF Build 3839").textContent).toContain(en["settings.game.cachedVersionDateUnknown"]);
  expect(line(development.name).textContent).toContain(en["settings.game.cachedVersionDevelopment"]);
  expect(sentCommands()).toHaveLength(0);
  const user = userEvent.setup();
  await user.click(folder);
  expect(shell.openVersionFolder).toHaveBeenCalledWith("FAF Build 3840");
  await user.click(external);
  expect(shell.openUrl).toHaveBeenCalledWith(version(3840).url);
});

it("loads shared release metadata once when absent and updates the shown dates", () => {
  seed([version(3840), version(3839)], [], false);
  render(<GameCacheSettingsSection />);
  expect(sentCommands()).toEqual([{ kind: "Changelog", command: { type: "load" } }]);
  applyEvent({ kind: "Changelog", event: { type: "loading" } });
  applyEvent({ kind: "Changelog", event: { type: "loaded", payload: { releases: [release("3840", "2026-10-20"), release("3839")] } } });
  expect(line("FAF Build 3840").textContent).toContain("Released: October 20, 2026");
  expect(sentCommands()).toHaveLength(1);
});

it("does not retry indefinitely after a metadata failure", () => {
  seed([version(3840)], [], false);
  render(<GameCacheSettingsSection />);
  applyEvent({ kind: "Changelog", event: { type: "loadFailed", payload: { reason: "Offline" } } });
  expect(line("FAF Build 3840").textContent).toContain(en["settings.game.cachedVersionDateUnknown"]);
  expect(sentCommands()).toHaveLength(1);
});

it("does not fetch a release index for development builds alone", () => {
  seed([development], [], false);
  render(<GameCacheSettingsSection />);
  expect(sentCommands()).toHaveLength(0);
  expect(line(development.name).textContent).toContain(en["settings.game.cachedVersionDevelopment"]);
});
