// The games the Play tab lists: the open custom games and the open co-op
// games, each after the search box, the hide switches and the filter rules,
// in the order the toolbar sorts them. Matchmaker games are in neither list.

import { useMemo } from "react";
import type { CustomGameBrowserPreferences, Game, VaultMap, VaultMod } from "../../../ipc/bindings";
import { isCoopGame, isCustomGameRanked } from "../../../shared/gameRules";
import { mapPresentation } from "../../../shared/mapPresentation";
import type { GameFilterRule } from "./GameFiltersModal";
import { matchesRule, shownDespiteFilters } from "./gameFilterRules";
import { compareGames } from "./gameSortOrder";
import type { SortMode } from "./CustomGamesToolbar";

const isMatchmakerGame = (game: Game) =>
  game.gameType.toLocaleLowerCase() === "matchmaker" ||
  game.visibility.toLocaleLowerCase() === "matchmaker";

export function useFilteredGames({
  games,
  search,
  gameBrowser,
  foes,
  mapVault,
  modVault,
}: {
  /** Every open game the lobby lists. */
  games: Game[];
  search: string;
  gameBrowser: CustomGameBrowserPreferences;
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
  const allowRules: GameFilterRule[] = gameBrowser.allowRules;
  const foeSet = useMemo(() => new Set(foes.map((f) => f.toLowerCase())), [foes]);

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
      .filter((game) => shownDespiteFilters(game, allowRules, mapVault, () =>
        (!hidePrivate || !game.passwordProtected)
        && (!hideModded || Object.keys(game.simMods).length === 0)
        && (!hideUnranked || isCustomGameRanked(game, mapVault, modVault))
        && (!hideFoes || !foeSet.has(game.host.toLowerCase()))
        && (!applyFilters || !rules.some((rule) => matchesRule(game, rule, mapVault)))))
      .sort((left, right) => compareGames(sort, sortReversed, left, right));
  }, [allowRules, applyFilters, customGames, foeSet, hideFoes, hideModded, hidePrivate, hideUnranked, mapVault, modVault, rules, search, sort, sortReversed]);

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
      .filter((game) => shownDespiteFilters(game, allowRules, mapVault, () =>
        (!hidePrivate || !game.passwordProtected)
        && (!hideModded || Object.keys(game.simMods).length === 0)
        && (!hideFoes || !foeSet.has(game.host.toLowerCase()))
        && (!applyFilters || !rules.some((rule) => matchesRule(game, rule, mapVault)))))
      .sort((left, right) => compareGames(sort, sortReversed, left, right));
    // No ranked filter here, and no checkbox for one in the co-op toolbar: a
    // mission is never rated, so hiding the unranked games hid all of them.
  }, [allowRules, applyFilters, coopGames, foeSet, hideFoes, hideModded, hidePrivate, mapVault, rules, search, sort, sortReversed]);

  return { customGames, coopGames, filtered, filteredCoopGames };
}
