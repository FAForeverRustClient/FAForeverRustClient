// @vitest-environment happy-dom
//
// The Play tab's custom games, mounted against a seeded store: joining from
// the details panel, from a double click and from the large preview, what a
// quick second press sends on each of those paths and on Host, an answer that
// lands after the preview it was asked from has closed, and the lobby
// connection dropping and coming back while the tab is open. The lists and
// the join follow the reducer: a blip keeps the games but forgets the join,
// a lost connection empties the tab, and nothing is left reading "Joining"
// once the replacement connection has sent the games again.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppCommand, CustomGameBrowserPreferences, Game, InstalledMap, PlayMode } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { useAppStore } from "../../store/store";
import { LobbyView } from "./LobbyView";

vi.mock("../../ipc/client");

failOnConsoleError();

const ME = { id: 7, name: "Me", roles: [] };

function game(id: number, title: string): Game {
  return {
    id,
    title,
    host: "Hosty",
    players: 1,
    maxPlayers: 4,
    map: "zz_open_field.v0001",
    modName: "faf",
    averageRating: 1200,
    ratingType: "global",
    passwordProtected: false,
    visibility: "public",
    gameType: "custom",
    launchedAt: null,
    hostedAt: null,
    ratingMin: null,
    ratingMax: null,
    enforceRatingRange: false,
    teams: { "1": ["Hosty"], "2": [] },
    simMods: {},
  };
}

const SETONS = game(101, "Friday Setons");
const GAP = game(102, "Gap of Rohan 2v2");

const installed: InstalledMap[] = [
  { folderName: "zz_alpha.v0001", displayName: "Zz Alpha", maxPlayers: 2, width: 256, height: 256 },
];

function mountPlayTab(browser: Partial<CustomGameBrowserPreferences> = {}) {
  seedStore((state) => ({
    ...state,
    auth: { ...state.auth, status: "loggedIn", player: ME },
    lobby: { ...state.lobby, status: "connected", playMode: "custom", games: [SETONS, GAP] },
    maps: { ...state.maps, installed },
    // Known, so a join goes straight out rather than asking for the list first.
    mods: { ...state.mods, installedStatus: { type: "ready" } },
    settings: {
      ...state.settings,
      browsing: {
        ...state.settings.browsing,
        customGamesView: "list",
        customGamesBrowser: { ...state.settings.browsing.customGamesBrowser, ...browser },
      },
      // The lineup overlay a hovered row opens closes on a 160 ms timer of its
      // own, module-wide; left on, that timer could land between two steps of
      // a slow run as an update outside `act`. It is not what these test.
      appearance: { ...state.settings.appearance, hoverPanels: false },
    },
  }));
  render(<LobbyView />);
}

/** The Lobby commands of one type, in the order they were sent. */
function lobbySent<T extends Extract<AppCommand, { kind: "Lobby" }>["command"]["type"]>(type: T) {
  return sentCommands()
    .filter((command): command is Extract<AppCommand, { kind: "Lobby" }> => command.kind === "Lobby")
    .map((command) => command.command)
    .filter((command) => command.type === type);
}

const row = (title: string) => screen.getByRole("button", { name: new RegExp(title) });
const joinOf = (id: number) => ({ type: "join", payload: { id, password: null, replaceMods: false } });

describe("LobbyView custom games, mounted", () => {
  it("joins the picked game with one join command and shows Joining once the backend answers", async () => {
    const user = userEvent.setup();
    mountPlayTab();
    expect(screen.getByText("Select a game to see its details.")).toBeDefined();

    await user.click(row("Friday Setons"));
    const join = screen.getByRole("button", { name: "Join game" });
    await user.click(join);

    expect(lobbySent("join")).toEqual([joinOf(SETONS.id)]);
    // Unchanged until the backend says the join is under way.
    expect(join.hasAttribute("disabled")).toBe(false);

    applyEvent({ kind: "Lobby", event: { type: "joining", payload: { id: SETONS.id, prepared: false } } });
    const joining = screen.getByRole("button", { name: "Joining…" });
    expect(joining.hasAttribute("disabled")).toBe(true);
  });

  it("sends a second join on a quick second click of Join, because the button waits for the backend", async () => {
    // Current behaviour, recorded rather than fixed: nothing between the
    // press and the backend's `joining` holds the button. The service drops
    // the second, since `try_begin_join` (`crates/faf-app/src/runtime/
    // policies.rs`) refuses a join while another holds the slot.
    const user = userEvent.setup();
    mountPlayTab();
    await user.click(row("Friday Setons"));

    await user.dblClick(screen.getByRole("button", { name: "Join game" }));
    expect(lobbySent("join")).toEqual([joinOf(SETONS.id), joinOf(SETONS.id)]);
  });

  it("joins once on a double click of a row", async () => {
    const user = userEvent.setup();
    mountPlayTab();

    await user.dblClick(row("Gap of Rohan 2v2"));
    expect(lobbySent("join")).toEqual([joinOf(GAP.id)]);
  });

  it("keeps a stepped-aside panel away for the double-click interval after a click picks a game", async () => {
    // A window narrow enough that the empty panel steps aside for the list's
    // columns, as at 1100 by 720. A click that brought it straight back moved
    // the list under the pointer, and a double click's second click landed on
    // the panel's map preview instead of joining.
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(700);
    try {
      const user = userEvent.setup();
      mountPlayTab();
      expect(screen.queryByText("Select a game to see its details.")).toBeNull();

      await user.click(row("Friday Setons"));
      expect(screen.queryByRole("button", { name: "Join game" })).toBeNull();

      // The second click of a double click, still on the row, joins.
      await user.dblClick(row("Friday Setons"));
      expect(lobbySent("join")).toEqual([joinOf(SETONS.id)]);

      // Once the interval has passed, the picked game's panel is there.
      await act(() => new Promise((resolve) => setTimeout(resolve, 550)));
      expect(screen.getByRole("button", { name: "Join game" })).toBeDefined();
    } finally {
      width.mockRestore();
    }
  });

  it("closes the preview on its Join, so a second click cannot send again, and shows a late refusal in the panel", async () => {
    const user = userEvent.setup();
    mountPlayTab();
    await user.click(row("Friday Setons"));
    await user.click(screen.getByRole("button", { name: "Preview map" }));
    const dialog = screen.getByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Join game" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lobbySent("join")).toEqual([joinOf(SETONS.id)]);

    // The answer arrives after the dialog that asked is gone.
    applyEvent({ kind: "Lobby", event: { type: "joinFailed", payload: { id: SETONS.id, reason: "Game is full" } } });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText(/Could not join/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Try joining again" }).hasAttribute("disabled")).toBe(false);
  });

  it("stays closed when the game of a closed preview changes and then leaves the list", async () => {
    const user = userEvent.setup();
    mountPlayTab();
    await user.click(row("Gap of Rohan 2v2"));
    await user.click(screen.getByRole("button", { name: "Preview map" }));
    // The footer's Close, not the corner cross: both are named "Close".
    const closes = within(screen.getByRole("dialog")).getAllByRole("button", { name: "Close" });
    await user.click(closes[closes.length - 1]);
    expect(screen.queryByRole("dialog")).toBeNull();

    applyEvent({ kind: "Lobby", event: { type: "gamesChanged", payload: { upserted: [{ ...GAP, players: 3 }], removed: [] } } });
    applyEvent({ kind: "Lobby", event: { type: "gamesChanged", payload: { upserted: [], removed: [GAP.id] } } });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Gap of Rohan/ })).toBeNull();
    expect(screen.getByText("Select a game to see its details.")).toBeDefined();
    expect(lobbySent("join")).toEqual([]);
  });

  it("forgets a join on a reconnect blip but keeps the list, so the button is not left on Joining", async () => {
    const user = userEvent.setup();
    mountPlayTab();
    await user.click(row("Friday Setons"));
    await user.click(screen.getByRole("button", { name: "Join game" }));
    applyEvent({ kind: "Lobby", event: { type: "joining", payload: { id: SETONS.id, prepared: false } } });
    expect(screen.getByRole("button", { name: "Joining…" })).toBeDefined();

    applyEvent({ kind: "Lobby", event: { type: "connecting" } });
    expect(row("Friday Setons")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Joining…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Join game" }).hasAttribute("disabled")).toBe(false);

    applyEvent({ kind: "Lobby", event: { type: "connected" } });
    expect(screen.getByRole("button", { name: "Join game" }).hasAttribute("disabled")).toBe(false);
    expect(lobbySent("join")).toHaveLength(1);
  });

  it("empties the tab when the connection is lost, reconnects on request, and restores the list and the picked game", async () => {
    const user = userEvent.setup();
    mountPlayTab();
    await user.click(row("Friday Setons"));
    await user.click(screen.getByRole("button", { name: "Join game" }));
    applyEvent({ kind: "Lobby", event: { type: "joining", payload: { id: SETONS.id, prepared: false } } });

    applyEvent({ kind: "Lobby", event: { type: "disconnected" } });
    expect(screen.getByText("Not connected to FAF")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Friday Setons/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Joining…" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(lobbySent("connect")).toHaveLength(1);

    applyEvent({ kind: "Lobby", event: { type: "connecting" } });
    expect(screen.getByText("Connecting to FAF…")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();

    applyEvent({ kind: "Lobby", event: { type: "connected" } });
    applyEvent({ kind: "Lobby", event: { type: "gamesUpdated", payload: { games: [SETONS, GAP] } } });
    expect(row("Friday Setons")).toBeDefined();
    expect(row("Gap of Rohan 2v2")).toBeDefined();
    // The game picked before the drop is the one in the panel again, ready to join.
    const join = screen.getByRole("button", { name: "Join game" });
    expect(join.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByRole("button", { name: "Joining…" })).toBeNull();
    expect(lobbySent("join")).toHaveLength(1);
  });

  it("sends connect again on a quick second click of Reconnect, because the button stays until the backend says connecting", async () => {
    // Current behaviour, recorded rather than fixed. The empty state's button
    // goes only when the backend reports `connecting`.
    const user = userEvent.setup();
    mountPlayTab();
    applyEvent({ kind: "Lobby", event: { type: "disconnected" } });

    await user.dblClick(screen.getByRole("button", { name: "Reconnect" }));
    expect(lobbySent("connect")).toHaveLength(2);
  });

  it("hosts once on a double click of Host game, because the dialog closes on the first", async () => {
    const user = userEvent.setup();
    mountPlayTab();
    await user.click(screen.getByRole("button", { name: "Host game" }));
    const dialog = screen.getByRole("dialog");
    const search = within(dialog).getByRole("textbox", { name: "Search maps" });
    await user.clear(search);
    await user.type(search, "Zz ");
    await user.click(within(dialog).getByRole("option", { name: /Zz Alpha/ }));

    await user.dblClick(within(dialog).getByRole("button", { name: "Host game" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lobbySent("host")).toHaveLength(1);
    expect(lobbySent("host")[0]).toMatchObject({ payload: { config: { map: "zz_alpha.v0001" } } });
  });
});

/** The backend's answer to a browsing patch: the list's preferences as they now are. */
function browserChanged(changes: Partial<CustomGameBrowserPreferences>) {
  const browsing = useAppStore.getState().state.settings.browsing;
  applyEvent({
    kind: "Settings",
    event: {
      type: "browsingChanged",
      payload: {
        preferences: { ...browsing, customGamesBrowser: { ...browsing.customGamesBrowser, ...changes } },
      },
    },
  });
}

const toolbar = () => {
  const element = document.querySelector<HTMLElement>(".play-toolbar");
  if (!element) throw new Error("no Play toolbar");
  return element;
};

describe("LobbyView filters, mounted", () => {
  it("keeps the hide switches in the filters dialog, and counts every filter that is on on its button", async () => {
    // Five checkboxes beside the search took the toolbar to two rows at the
    // default window. They are in the dialog now, and the button's count is
    // what still says that two of them are hiding games.
    const user = userEvent.setup();
    mountPlayTab({
      hidePrivate: true,
      hideFoes: true,
      applyFilters: true,
      rules: [{ field: "map", constraint: "contains", value: "seton" }],
    });

    expect(within(toolbar()).queryAllByRole("checkbox")).toEqual([]);
    // Two switches and one applied rule.
    await user.click(within(toolbar()).getByRole("button", { name: "Filters (3)" }));

    const dialog = screen.getByRole("dialog");
    const box = (name: string) => within(dialog).getByRole<HTMLInputElement>("checkbox", { name });
    expect(box("Hide private").checked).toBe(true);
    expect(box("Hide sim-modded").checked).toBe(false);
    expect(box("Hide unranked").checked).toBe(false);
    expect(box("Hide foes").checked).toBe(true);
    expect(box("Apply filters").checked).toBe(true);

    // A switch writes the same setting it wrote from the toolbar.
    clearSentCommands();
    await user.click(box("Hide sim-modded"));
    expect(sentCommands()).toEqual([
      {
        kind: "Settings",
        command: { type: "patchBrowsing", payload: { patch: { customGamesBrowser: { hideModded: true } } } },
      },
    ]);

    browserChanged({ hideModded: true });
    expect(box("Hide sim-modded").checked).toBe(true);
    expect(within(toolbar()).getByRole("button", { name: "Filters (4)" })).toBeDefined();

    // Rules that are not applied hide nothing, so they are not counted.
    browserChanged({ applyFilters: false });
    expect(within(toolbar()).getByRole("button", { name: "Filters (3)" })).toBeDefined();
  });

  it("offers no ranked switch from co-op, where every mission is unranked, and does not count it", async () => {
    const user = userEvent.setup();
    mountPlayTab({ hideUnranked: true, hidePrivate: true });
    expect(within(toolbar()).getByRole("button", { name: "Filters (2)" })).toBeDefined();

    applyEvent({ kind: "Lobby", event: { type: "playModeChanged", payload: { mode: "coop" } } });
    await user.click(within(toolbar()).getByRole("button", { name: "Filters (1)" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("checkbox", { name: "Hide private" })).toBeDefined();
    expect(within(dialog).queryByRole("checkbox", { name: "Hide unranked" })).toBeNull();
  });
});

describe("LobbyView mode tabs, mounted", () => {
  /**
   * The mode tab that is selected, and the element its `aria-controls`
   * names, which must be the tab panel that names the tab back.
   */
  function selectedTabAndPanel() {
    const tab = screen.getAllByRole("tab").find((element) => element.getAttribute("aria-selected") === "true");
    if (!tab) throw new Error("no selected mode tab");
    const controls = tab.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    const panel = document.getElementById(controls ?? "");
    expect(panel?.getAttribute("role")).toBe("tabpanel");
    expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
    return { tab, panel };
  }

  it("ties each mode tab to the panel it shows", () => {
    mountPlayTab();
    const modes: [PlayMode, string, string][] = [
      ["custom", "Custom", "custom-games-layout"],
      ["matchmaking", "Matchmaker", ""],
      ["coop", "Coop", "coop-panel"],
      ["galacticWar", "Galactic War", "gw-layout"],
    ];

    for (const [mode, label, panelClass] of modes) {
      applyEvent({ kind: "Lobby", event: { type: "playModeChanged", payload: { mode } } });
      const { tab, panel } = selectedTabAndPanel();
      expect(tab.textContent).toMatch(new RegExp(`^${label}`));
      // The panel is the mode's own layout, not a box around it: the layouts
      // are sized as children of the Play view. The matchmaker has no queues
      // here, so its panel is the loading state's.
      if (panelClass) expect(panel?.classList.contains(panelClass)).toBe(true);
      else expect(within(panel as HTMLElement).getByText("Loading matchmaker queues")).toBeDefined();
    }
  });
});
