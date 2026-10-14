// The games the Play tab lists: the open custom games and the open co-op
// games, each after the search box, the hide switches and the filter rules,
// in the order the toolbar sorts them. Matchmaker games are in neither list.

import { useMemo } from "react";
import type { CustomGameBrowserPreferences, Game, VaultMap, VaultMod } from "../../../ipc/bindings";
import { isCoopGame, isCustomGameRanked } from "../../../shared/gameRules";
import { mapPresentation } from "../../../shared/mapPresentation";
import type { GameFilterRule } from "./GameFiltersModal";
import { compareGames } from "./gameSortOrder";
import { hostWhitelist, shownDespiteFilters } from "./hostWhitelist";
import type { SortMode } from "./CustomGamesToolbar";

const isMatchmakerGame = (game: Game) =>
  game.gameType.toLocaleLowerCase() === "matchmaker" ||
  game.visibility.toLocaleLowerCase() === "matchmaker";

function matchesRule(game: Game, rule: GameFilterRule, vault: VaultMap[]) {
  if (rule.field === "rating") {
    const target = Number(rule.value);
    if (!Number.isFinite(target)) return false;
    if (rule.constraint === "above") return Number(game.averageRating) > target;
    if (rule.constraint === "below") return Number(game.averageRating) < target;
    if (rule.constraint === "notEquals") return Number(game.averageRating) !== target;
    return Number(game.averageRating) === target;
  }
  const target = rule.value.replace(/^["']|["']$/g, "").trim().toLocaleLowerCase();
  if (!target) return false;

  const testString = (val: string) => {
    const value = val.toLocaleLowerCase();
    if (rule.constraint === "starts") return value.startsWith(target);
    if (rule.constraint === "ends") return value.endsWith(target);
    if (rule.constraint === "equals") return value === target;
    if (rule.constraint === "notEquals") return value !== target;
    return value.includes(target);
  };

  if (rule.field === "title") {
    return testString(game.title);
  }
  if (rule.field === "host") {
    return testString(game.host);
  }
  if (rule.field === "map") {
    const mapDisplay = mapPresentation(vault, game.map).displayName;
    return testString(game.map) || testString(mapDisplay);
  }
  if (rule.field === "titleOrMap") {
    const mapDisplay = mapPresentation(vault, game.map).displayName;
    return testString(game.title) || testString(game.map) || testString(mapDisplay);
  }
  if (rule.field === "mod") {
    return testString(game.modName);
  }
  return false;
}

export function useFilteredGames({
  games,
  search,
  gameBrowser,
  whitelistedHosts,
  foes,
  mapVault,
  modVault,
}: {
  /** Every open game the lobby lists. */
  games: Game[];
  search: string;
  gameBrowser: CustomGameBrowserPreferences;
  whitelistedHosts: string[];
  foes: string[];
  mapVault: VaultMap[];
  modVault: VaultMod[];
}) {
  const sort: SortMode = gameBrowser.sort;
  const sortReversed = gameBrowser.sortReversed;
  const hidePrivate = gameBrowser.hidePrivate;
  const hideModded = gameBrowser.hideModded;
  const hideUnranked = gameBrowser.hideUnranked;
  const hideFoes = gameBrowser.hideFoes;
  const applyFilters = gameBrowser.applyFilters;
  const rules: GameFilterRule[] = gameBrowser.rules;
  const foeSet = useMemo(() => new Set(foes.map((f) => f.toLowerCase())), [foes]);
  const whitelist = useMemo(() => hostWhitelist(whitelistedHosts), [whitelistedHosts]);

  const customGames = useMemo(
    () => games.filter((game) => !isCoopGame(game) && !isMatchmakerGame(game)),
    [games],
  );
  const coopGames = useMemo(
    () => games.filter((game) => isCoopGame(game) && !isMatchmakerGame(game)),
    [games],
  );

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return customGames
      .slice()
      .filter(
        (game) =>
          !query ||
          [
            game.title,
            game.host,
            game.map,
            mapPresentation(mapVault, game.map).displayName,
            game.modName,
          ].some((value) => value.toLocaleLowerCase().includes(query)),
      )
      .filter((game) => shownDespiteFilters(game.host, whitelist, () =>
        (!hidePrivate || !game.passwordProtected)
        && (!hideModded || Object.keys(game.simMods).length === 0)
        && (!hideUnranked || isCustomGameRanked(game, mapVault, modVault))
        && (!hideFoes || !foeSet.has(game.host.toLowerCase()))
        && (!applyFilters || !rules.some((rule) => matchesRule(game, rule, mapVault)))))
      .sort((left, right) => compareGames(sort, sortReversed, left, right));
  }, [applyFilters, customGames, foeSet, hideFoes, hideModded, hidePrivate, hideUnranked, mapVault, modVault, rules, search, sort, sortReversed, whitelist]);

  const filteredCoopGames = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return coopGames
      .slice()
      .filter(
        (game) =>
          !query ||
          [
            game.title,
            game.host,
            game.map,
            mapPresentation(mapVault, game.map).displayName,
            game.modName,
          ].some((value) => value.toLocaleLowerCase().includes(query)),
      )
      .filter((game) => shownDespiteFilters(game.host, whitelist, () =>
        (!hidePrivate || !game.passwordProtected)
        && (!hideModded || Object.keys(game.simMods).length === 0)
        && (!hideFoes || !foeSet.has(game.host.toLowerCase()))
        && (!applyFilters || !rules.some((rule) => matchesRule(game, rule, mapVault)))))
      .sort((left, right) => compareGames(sort, sortReversed, left, right));
    // No ranked filter here, and no checkbox for one in the co-op toolbar: a
    // mission is never rated, so hiding the unranked games hid all of them.
  }, [applyFilters, coopGames, foeSet, hideFoes, hideModded, hidePrivate, mapVault, rules, search, sort, sortReversed, whitelist]);

  return { customGames, coopGames, filtered, filteredCoopGames };
}
