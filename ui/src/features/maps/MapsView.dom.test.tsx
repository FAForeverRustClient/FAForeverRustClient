// @vitest-environment happy-dom
//
// The map vault tab, mounted against the store: a failed catalogue load and a
// failed search each offer Retry and send their own command again, a page
// where some previews fail or some records are thin still shows every map,
// with a placeholder or a stand-in where the data is missing, and Install
// is not guarded against a double click until the backend says it is
// installing.

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { AppCommand, MapsEvent, MapVaultQuery, VaultMap } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { rememberFilter, resetFilterMemoryForTests } from "../../shared/filterMemory";
import { hasMapVaultFocus, requestMapVaultFocus, takeMapVaultFocus } from "../../shared/mapVaultFocus";
import { EMPTY_MAP_QUERY } from "../../shared/vaultQuery";
import type { MapFilterState } from "./mapVaultFilters";
import { MapsView } from "./MapsView";

vi.mock("../../ipc/client");

failOnConsoleError();

beforeEach(resetFilterMemoryForTests);
afterEach(() => {
  resetFilterMemoryForTests();
  takeMapVaultFocus();
});

function vaultMap(versionId: number, displayName: string, overrides: Partial<VaultMap> = {}): VaultMap {
  const folder = displayName.toLowerCase().replace(/\s+/g, "_");
  return {
    mapId: versionId,
    versionId,
    displayName,
    author: "Mapper",
    authorId: 77,
    folderName: `${folder}.v0001`,
    version: "1",
    description: "",
    mapType: "skirmish",
    maxPlayers: 4,
    width: 512,
    height: 512,
    gamesPlayed: 10,
    versionGamesPlayed: 10,
    ranked: true,
    hidden: false,
    recommended: false,
    ratingTenths: 40,
    reviews: 3,
    createdAt: "2025-01-01T00:00:00Z",
    downloadUrl: `https://content.example/maps/${folder}.zip`,
    thumbnailUrl: `https://content.example/previews/${folder}.png`,
    thumbnailUrlLarge: `https://content.example/previews/large/${folder}.png`,
    ...overrides,
  };
}

const mapsEvent = (event: MapsEvent) => applyEvent({ kind: "Maps", event });

function sentMaps(type: string): AppCommand[] {
  return sentCommands().filter((command) => command.kind === "Maps" && command.command.type === type);
}

/** The vault tab as it opens, and the search it sent for its first page. */
function mountVault(): { query: MapVaultQuery } {
  render(<MapsView />);
  const searches = sentMaps("searchVault");
  expect(searches).toHaveLength(1);
  const search = searches[0];
  if (search.kind !== "Maps" || search.command.type !== "searchVault") throw new Error("not a vault search");
  clearSentCommands();
  return { query: search.command.payload.query };
}

function answerSearch(query: MapVaultQuery, maps: VaultMap[]) {
  mapsEvent({ type: "vaultSearching" });
  mapsEvent({ type: "vaultSearched", payload: { maps, query, totalPages: 1, totalRecords: maps.length } });
}

/** One card in the results grid, by the map's name. */
const cardOf = (name: string) => {
  const card = screen.getByRole("button", { name: `View ${name}` }).closest("article");
  if (!card) throw new Error(`no card for ${name}`);
  return card;
};

describe("Map vault, mounted", () => {
  it("asks for the catalogue, the installed list and the first page when it opens", () => {
    render(<MapsView />);
    expect(sentMaps("loadVault")).toHaveLength(1);
    expect(sentMaps("loadInstalled")).toHaveLength(1);
    expect(sentMaps("searchVault")).toHaveLength(1);
  });

  it("offers Retry on a failed search and sends the same search again", async () => {
    const user = userEvent.setup();
    const { query } = mountVault();
    mapsEvent({ type: "vaultSearching" });
    mapsEvent({ type: "vaultSearchFailed", payload: { reason: "HTTP 500" } });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not search the map vault");
    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(sentMaps("searchVault")).toEqual([{ kind: "Maps", command: { type: "searchVault", payload: { query } } }]);

    answerSearch(query, [vaultMap(1, "Alpha")]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(cardOf("Alpha")).toBeTruthy();
  });

  it("retries a failed catalogue load with its own command, separately from the search", async () => {
    const user = userEvent.setup();
    const { query } = mountVault();
    answerSearch(query, [vaultMap(1, "Alpha")]);
    mapsEvent({ type: "vaultLoadFailed", payload: { reason: "HTTP 503" } });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Could not load map vault");
    // The page that did load stays on screen under the failure.
    expect(cardOf("Alpha")).toBeTruthy();

    await user.click(within(alert).getByRole("button", { name: "Retry" }));
    expect(sentMaps("loadVault")).toEqual([{ kind: "Maps", command: { type: "loadVault" } }]);
    expect(sentMaps("searchVault")).toEqual([]);
  });

  it("shows every map on a page where some previews fail and some records are thin", () => {
    const { query } = mountVault();
    answerSearch(query, [
      vaultMap(1, "Alpha"),
      vaultMap(2, "Broken Art"),
      vaultMap(3, "Bare Record", {
        author: null,
        maxPlayers: 0,
        downloadUrl: "",
        thumbnailUrl: "",
        thumbnailUrlLarge: "",
      }),
    ]);
    // The server's total for this search, not the count on the page.
    expect(screen.getByText("3 maps")).toBeTruthy();

    // The listed art fails, then the CDN's: the card falls back to its icon.
    const broken = cardOf("Broken Art");
    fireEvent.error(within(broken).getByRole("img", { name: "Broken Art preview" }));
    const fallback = within(broken).getByRole("img", { name: "Broken Art preview" });
    expect(fallback.getAttribute("src")).toBe("https://content.faforever.com/maps/previews/small/broken_art.v0001.png");
    fireEvent.error(fallback);
    expect(within(broken).queryByRole("img")).toBeNull();
    expect(broken.querySelector(".map-vault-preview-empty")).not.toBeNull();

    // The healthy card keeps its own art.
    expect(within(cardOf("Alpha")).getByRole("img", { name: "Alpha preview" }).getAttribute("src"))
      .toBe("https://content.example/previews/alpha.png");

    // A record with no author, no slot count and nothing to download from
    // still shows, says what it does not know, and offers no install.
    const bare = cardOf("Bare Record");
    expect(within(bare).getByText("Unknown author", { exact: false })).toBeTruthy();
    expect(within(bare).getByText("N/A", { exact: false })).toBeTruthy();
    expect(within(bare).getByRole("button", { name: "Install" })).toHaveProperty("disabled", true);
    expect(within(cardOf("Alpha")).getByRole("button", { name: "Install" })).toHaveProperty("disabled", false);
  });

  it("does not guard Install: a double click sends two installs until the backend says it is installing", async () => {
    const user = userEvent.setup();
    const { query } = mountVault();
    const alpha = vaultMap(1, "Alpha");
    answerSearch(query, [alpha]);
    const install = within(cardOf("Alpha")).getByRole("button", { name: "Install" });
    const command: AppCommand = {
      kind: "Maps",
      command: { type: "installMap", payload: { folderName: alpha.folderName, downloadUrl: alpha.downloadUrl } },
    };

    await user.dblClick(install);
    expect(sentMaps("installMap")).toEqual([command, command]);

    mapsEvent({ type: "installing", payload: { folderName: alpha.folderName } });
    const busy = within(cardOf("Alpha")).getByRole("button", { name: "Installing…" });
    expect(busy).toHaveProperty("disabled", true);
    clearSentCommands();
    await user.dblClick(busy);
    expect(sentMaps("installMap")).toEqual([]);
  });
});

describe("opening a specific map in the vault", () => {
  const remembered: MapFilterState = {
    search: "Old search",
    author: "OtherMapper",
    sort: "name",
    ranked: "ranked",
    installFilter: "installed",
    createdAfter: "2026-01-01",
    createdBefore: "2026-02-01",
    showHidden: false,
    minimumRating: 4,
    maximumRating: 5,
    minimumPlayers: 2,
    maximumPlayers: 4,
    width: 64,
    height: 64,
  };
  const oldQuery: MapVaultQuery = {
    ...EMPTY_MAP_QUERY,
    search: remembered.search,
    author: remembered.author,
    ranked: true,
    after: remembered.createdAfter,
    before: remembered.createdBefore,
    minRatingTenths: 40,
    maxRatingTenths: 50,
    minPlayers: 2,
    maxPlayers: 4,
    width: 64,
    height: 64,
    sortBy: "name",
    sortDescending: false,
    page: 7,
  };
  const lastSearch = () => {
    const queries = sentCommands().flatMap(command =>
      command.kind === "Maps" && command.command.type === "searchVault" ? [command.command.payload.query] : []);
    return queries[queries.length - 1];
  };

  function restoreSearch(memory: "session" | "restart", saveFilters: boolean, downloaded = false) {
    const savedFilters: Record<string, string> = memory === "restart" && saveFilters
      ? { "maps.vault": JSON.stringify(remembered) }
      : {};
    seedStore(state => ({
      ...state,
      settings: {
        ...state.settings,
        general: { ...state.settings.general, filterMemory: memory },
        browsing: {
          ...state.settings.browsing,
          mapVaultPreset: "all",
          mapVaultSort: downloaded ? "downloaded" : "name",
          rememberedFilters: savedFilters,
        },
      },
      maps: { ...state.maps, browseQuery: downloaded ? EMPTY_MAP_QUERY : oldQuery },
    }));
    if (memory === "session" && saveFilters) rememberFilter("maps.vault", remembered);
  }

  it.each([
    { memory: "session" as const, saved: true },
    { memory: "restart" as const, saved: true },
    { memory: "session" as const, saved: false },
  ])("clears $memory filters (saved: $saved) and selects the requested map", ({ memory, saved }) => {
    restoreSearch(memory, saved);
    requestMapVaultFocus({ name: "Target Map", folderName: "target.v0001" });
    render(<StrictMode><MapsView /></StrictMode>);
    const query = lastSearch();
    expect(query).toEqual({ ...EMPTY_MAP_QUERY, search: "Target Map", sortBy: "name", sortDescending: false });
    const target = vaultMap(101, "Target Map", { folderName: "target.v0001", author: "NewMapper", ranked: false });
    answerSearch(query, [vaultMap(100, "Another Map"), target]);
    expect(cardOf("Target Map")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Target Map" })).toBeTruthy();
    expect(hasMapVaultFocus()).toBe(false);
  });

  it("leaves the downloaded-only view when opening an uninstalled map", () => {
    restoreSearch("session", false, true);
    requestMapVaultFocus({ name: "Target Map", folderName: "target.v0001" });
    render(<MapsView />);
    const query = lastSearch();
    expect(query).toEqual({ ...EMPTY_MAP_QUERY, search: "Target Map", sortBy: "name", sortDescending: false });
  });

  it("restores remembered filters during an ordinary return to the tab", () => {
    restoreSearch("session", true);
    render(<MapsView />);
    expect(lastSearch()).toEqual(oldQuery);
  });
});
