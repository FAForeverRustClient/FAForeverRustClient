// @vitest-environment happy-dom

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppCommand, ReplayQuery } from "../../ipc/bindings";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import { DEFAULT_BROWSING_PREFERENCES } from "../../shared/browsingPreferences";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { EMPTY_LOCAL_REPLAY_QUERY, type LocalReplayQuery } from "./local/localReplayQuery";
import { LocalReplaySearch } from "./local/LocalReplaySearch";
import { VaultSearch } from "./online/VaultSearch";
import { SHORT_GAME_MINUTES } from "./replayPresets";
import {
  encodeLocalReplayPreset,
  encodeOnlineReplayPreset,
  LOCAL_REPLAY_PRESET_LIST,
  ONLINE_REPLAY_PRESET_LIST,
} from "./savedReplaySearches";

vi.mock("../../ipc/client");

failOnConsoleError();

function settingsCommands() {
  return sentCommands().flatMap((command: AppCommand) =>
    command.kind === "Settings" ? [command.command] : [],
  );
}

describe("ReplaySavedSearches", () => {
  it("saves the current online search via Enter without submitting the outer search form", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    seedStore((state) => state);

    render(
      <VaultSearch
        featuredMods={["faf"]}
        leaderboards={[]}
        self="TestPlayer"
        friends={[]}
        initialQuery={{ ...EMPTY_REPLAY_QUERY, map: "Seton's Clutch", minRating: 1600 }}
        onSearch={onSearch}
      />,
    );
    clearSentCommands();

    await user.click(screen.getByRole("button", { name: "Saved searches" }));
    const dialog = screen.getByRole("dialog", { name: "Saved searches" });
    const nameInput = within(dialog).getByLabelText("Name of the saved search");
    await user.type(nameInput, "High Setons{Enter}");

    expect(onSearch).not.toHaveBeenCalled();
    expect(settingsCommands()).toEqual([
      {
        type: "saveSearchPreset",
        payload: {
          preset: {
            list: ONLINE_REPLAY_PRESET_LIST,
            name: "High Setons",
            query: encodeOnlineReplayPreset(
              { ...EMPTY_REPLAY_QUERY, map: "Seton's Clutch", minRating: 1600 },
              [],
            ),
          },
        },
      },
    ]);
  });

  it("warns before overwriting a namesake preset, applies presets in one click, and deletes presets", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn<(query: ReplayQuery) => void>();
    const savedQuery: ReplayQuery = {
      ...EMPTY_REPLAY_QUERY,
      player: "Tagada",
      map: "Dual Gap",
      minDurationMinutes: SHORT_GAME_MINUTES,
      after: "2026-01-15",
      replayIds: ["77"],
    };

    seedStore((state) => ({
      ...state,
      settings: {
        ...state.settings,
        social: {
          ...state.settings.social,
          replayNotes: [{ replayId: 77, path: null, comment: "", tags: ["cast"] }],
        },
        browsing: {
          ...state.settings.browsing,
          searchPresets: [
            {
              list: ONLINE_REPLAY_PRESET_LIST,
              name: "Cast Games",
              query: encodeOnlineReplayPreset(savedQuery, ["cast"]),
            },
            {
              list: LOCAL_REPLAY_PRESET_LIST,
              name: "Local Only",
              query: encodeLocalReplayPreset(EMPTY_LOCAL_REPLAY_QUERY),
            },
          ],
        },
      },
    }));

    render(
      <VaultSearch
        featuredMods={["faf"]}
        leaderboards={[]}
        self="TestPlayer"
        friends={[]}
        initialQuery={EMPTY_REPLAY_QUERY}
        onSearch={onSearch}
      />,
    );
    clearSentCommands();

    const trigger = screen.getByRole("button", { name: "Saved searches (1)" });
    expect(trigger.className).not.toContain("has-active-preset");

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Saved searches" });
    expect(within(dialog).queryByText("Local Only")).toBeNull();

    // Typing the existing name (any case) switches Save -> Overwrite.
    const nameInput = within(dialog).getByLabelText("Name of the saved search");
    await user.type(nameInput, "cast games");
    expect(within(dialog).getByRole("button", { name: "Overwrite" })).toBeTruthy();
    expect(within(dialog).getByText('Replaces the saved search "Cast Games".')).toBeTruthy();

    // Applying the preset populates form fields, closes the dialog, marks active, and runs search.
    await user.click(within(dialog).getByRole("button", { name: /^Cast Games/ }));
    expect(screen.queryByRole("dialog", { name: "Saved searches" })).toBeNull();
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch.mock.calls[0]?.[0]).toEqual({
      ...savedQuery,
      page: 1,
      pageSize: EMPTY_REPLAY_QUERY.pageSize,
    });
    expect(screen.getByLabelText<HTMLInputElement>("Player").value).toBe("Tagada");
    expect(screen.getByLabelText<HTMLInputElement>("Map").value).toBe("Dual Gap");
    expect(screen.getByRole("button", { name: "Saved searches (1)" }).className).toContain(
      "has-active-preset",
    );

    // Deleting dispatches deleteSearchPreset without running another search, and Escape closes.
    clearSentCommands();
    onSearch.mockClear();
    await user.click(screen.getByRole("button", { name: "Saved searches (1)" }));
    await user.click(screen.getByRole("button", { name: "Delete the saved search Cast Games" }));
    expect(onSearch).not.toHaveBeenCalled();
    expect(settingsCommands()).toEqual([
      {
        type: "deleteSearchPreset",
        payload: { list: ONLINE_REPLAY_PRESET_LIST, name: "Cast Games" },
      },
    ]);

    applyEvent({
      kind: "Settings",
      event: {
        type: "browsingChanged",
        payload: {
          preferences: {
            ...DEFAULT_BROWSING_PREFERENCES,
            searchPresets: [
              {
                list: LOCAL_REPLAY_PRESET_LIST,
                name: "Local Only",
                query: encodeLocalReplayPreset(EMPTY_LOCAL_REPLAY_QUERY),
              },
            ],
          },
        },
      },
    });
    expect(screen.getByText(/No saved searches yet/)).toBeTruthy();

    // Undo puts the deleted search back exactly as it was saved.
    expect(screen.getByText('Deleted "Cast Games".', { exact: false })).toBeTruthy();
    clearSentCommands();
    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(settingsCommands()).toEqual([
      {
        type: "saveSearchPreset",
        payload: {
          preset: {
            list: ONLINE_REPLAY_PRESET_LIST,
            name: "Cast Games",
            query: encodeOnlineReplayPreset(savedQuery, ["cast"]),
          },
        },
      },
    ]);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Saved searches" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Saved searches" }));
  });

  it("applies saved presets in the local replay archive", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn<(query: LocalReplayQuery) => void>();
    const localPreset: LocalReplayQuery = {
      ...EMPTY_LOCAL_REPLAY_QUERY,
      player: "Harzer",
      gameMode: "ladder_1v1",
      onlyWatchable: true,
    };

    seedStore((state) => ({
      ...state,
      settings: {
        ...state.settings,
        browsing: {
          ...state.settings.browsing,
          searchPresets: [
            {
              list: LOCAL_REPLAY_PRESET_LIST,
              name: "Watchable Ladder",
              query: encodeLocalReplayPreset(localPreset),
            },
          ],
        },
      },
    }));

    render(
      <LocalReplaySearch
        initialQuery={EMPTY_LOCAL_REPLAY_QUERY}
        self="TestPlayer"
        featuredMods={["faf"]}
        loading={false}
        busy={false}
        onSearch={onSearch}
        onRefresh={() => undefined}
        onOpenFile={() => undefined}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Saved searches (1)" }));
    await user.click(screen.getByRole("button", { name: /^Watchable Ladder/ }));

    expect(onSearch).toHaveBeenCalledWith(localPreset);
    expect(screen.getByLabelText<HTMLInputElement>("Player").value).toBe("Harzer");
    expect(screen.getByRole("button", { name: "Saved searches (1)" }).className).toContain(
      "has-active-preset",
    );
  });
});
