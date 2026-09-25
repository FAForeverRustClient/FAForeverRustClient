// "Which mode was this played in", as one question the API can actually
// answer.
//
// The vault search used to ask it as a leaderboard multi-select, which was a
// truthful name for the field and a poor name for the question: nobody thinks
// of a custom game as "the global leaderboard", and co-op games, which are not
// on a leaderboard at all, could not be asked for.
//
// Two RSQL clauses exist, and they are ANDed:
//
//   playerStats.ratingChanges.leaderboard.technicalName == <board>
//   featuredMod.technicalName == <mod>
//
// A mode picks exactly one of them. That is why this is a single choice rather
// than a multi-select: "custom games or co-op" would be the two clauses at
// once, which is an AND, which is a search that cannot match anything. A
// control that can express an empty-by-construction query is worse than one
// that asks a blunter question honestly.
//
// The mod filter itself is untouched by all this and still lives in the
// advanced panel, for `fafbeta` and `fafdevelop`. The one thing this control
// owns there is `coop`, because that is how a co-op game is identified.

import type { RatingLeaderboard, ReplayQuery } from "../../../ipc/bindings";
import { t } from "../../../i18n";
import { GLOBAL_LEADERBOARD, leaderboardLabel } from "../../../shared/playerRatings";
import { COOP_FEATURED_MOD } from "../../../shared/replayQuery";

export { COOP_FEATURED_MOD } from "../../../shared/replayQuery";

export interface ReplayGameMode {
  /** The `<option>` value. Empty is "any". */
  id: string;
  label: string;
  /** The leaderboard clause this mode asks for, if it asks for one. */
  leaderboards: string[];
}

/**
 * The modes to offer, given the rating boards the API listed.
 *
 * **Rating leaderboards, not leagues.** The two lists are different resources
 * with different technical names: `/data/leaderboard` is `global`,
 * `ladder_1v1`, `tmm_2v2`, and `/data/league` is `1v1_league`, `2v2_league`.
 * The clause this control writes is matched against the *leaderboard* name, so
 * a league name in it matches nothing at all: every mode but custom games and
 * co-op returned an empty page, which is what #228's follow-up reported. Custom
 * games worked by accident, because `global` is added below whatever the API
 * said.
 *
 * Built from the API's own list rather than from a table here, so a board FAF
 * adds appears without a release: the only thing this file decides is that
 * `global` is what a player calls a custom game, and that co-op exists at all.
 */
export function replayGameModes(boards: RatingLeaderboard[]): ReplayGameMode[] {
  const mode = (technicalName: string): ReplayGameMode => ({
    id: technicalName,
    label: technicalName === GLOBAL_LEADERBOARD
      ? t("replays.search.mode.custom")
      : leaderboardLabel(technicalName),
    leaderboards: [technicalName],
  });
  const names = boards.map((board) => board.technicalName);
  // Custom games whatever the catalogue said, and first: it is the mode most
  // of the vault is, and the tab must not be missing it because the
  // leaderboard catalogue has not loaded (or failed).
  const listed = names.includes(GLOBAL_LEADERBOARD) ? names : [GLOBAL_LEADERBOARD, ...names];
  return [
    { id: "", label: t("replays.search.mode.any"), leaderboards: [] },
    ...listed.map(mode),
    { id: COOP_FEATURED_MOD, label: t("replays.search.mode.coop"), leaderboards: [] },
  ];
}

/**
 * Which mode the query in the form is already asking for.
 *
 * Derived rather than stored, so the control cannot disagree with the search
 * that is actually running: a co-op mod filter set by hand in the advanced
 * panel shows up here as Co-op, which is what it is.
 */
export function selectedGameMode(query: Pick<ReplayQuery, "leaderboards" | "featuredMods">): string {
  if (query.featuredMods.includes(COOP_FEATURED_MOD)) return COOP_FEATURED_MOD;
  return query.leaderboards.length === 1 ? query.leaderboards[0] : "";
}

/**
 * The query with one mode selected.
 *
 * Co-op is the only mode that touches the mod filter, and it puts the rest of
 * it back when another mode is chosen: a search for `fafbeta` games that the
 * reader set in the advanced panel survives a change of mode, and the `coop`
 * entry this control added does not linger.
 */
export function withGameMode(query: ReplayQuery, mode: string): ReplayQuery {
  const featuredMods = query.featuredMods.filter((mod) => mod !== COOP_FEATURED_MOD);
  return mode === COOP_FEATURED_MOD
    ? { ...query, leaderboards: [], featuredMods: [...featuredMods, COOP_FEATURED_MOD], page: 1 }
    : { ...query, leaderboards: mode ? [mode] : [], featuredMods, page: 1 };
}
