// "Which mode was this played in", for a file on disk, in the online tab's own
// words: custom games, 1v1, 2v2, 3v3, 4v4 Full Share, co-op.
//
// The labels come from `leaderboardLabel`, the same function the online picker
// and every rating in the client use, so the two tabs cannot drift apart in
// wording and a board FAF renames is renamed in both at once.
//
// ## What the file actually says, and what these options therefore mean
//
// A `.fafreplay` envelope carries the featured mod and the roster. It does not
// carry the matchmaker queue. `game_type` looks like it should -- the lobby
// writes `matchmaker` or `custom` there when this client records a game -- but
// a replay downloaded from the vault carries the *victory condition* in that
// same field (DEMORALIZATION, DOMINATION, SANDBOX, UNKNOWN across 93 files of
// a real archive), so the field means two different things depending on who
// wrote the file and no filter can stand on it.
//
// So the sizes are read off the roster: two sides of three is a 3v3. Co-op and
// ladder come from the featured mod, which does name those two outright.
//
// **These options overlap, and that is deliberate.** Online they partition the
// vault, because each one is a leaderboard and a game is rated on exactly one.
// Here a custom 3v3 is both a custom game and a 3v3, and it answers to both,
// because those are the two true things the file says about it. A filter list
// is a set of questions, not a partition, and the alternative -- picking one
// bucket per replay -- would mean either a "Custom" that hides most of the
// archive or sizes that are empty for every game not recorded by this client.

import type { LocalReplay } from "../../ipc/bindings";
import { t } from "../../i18n";
import { leaderboardLabel } from "../../shared/playerRatings";

/** The featured mod a co-op game carries. */
const COOP_FEATURED_MOD = "coop";
/** The featured mod a ladder game carries; the leaderboard spells it with an underscore. */
const LADDER_FEATURED_MOD = "ladder1v1";

/**
 * The boards whose sizes are offered, in the order the matchmaker lists them.
 *
 * Technical names rather than "1v1", so the labels stay shared with the rest
 * of the client; `tmm_4v4_full_share` is the board's real name and reads as
 * "4v4 Full Share".
 */
const SIZE_BOARDS = ["ladder_1v1", "tmm_2v2", "tmm_3v3", "tmm_4v4_full_share"] as const;

/** How many a side of each of those boards holds. */
const SIDE_OF: Record<(typeof SIZE_BOARDS)[number], number> = {
  ladder_1v1: 1,
  tmm_2v2: 2,
  tmm_3v3: 3,
  tmm_4v4_full_share: 4,
};

/** Empty is "any mode", the default. */
export type LocalGameMode = "" | "custom" | "coop" | (typeof SIZE_BOARDS)[number];

export interface LocalGameModeOption {
  id: LocalGameMode;
  label: string;
}

/**
 * The modes to offer.
 *
 * A fixed list, not one built from the archive: these are the questions a
 * replay file can answer, whether or not this particular folder holds one of
 * each. An empty Co-op result is a fact about the archive, while a missing
 * Co-op entry would look like a fact about the client.
 */
export function localGameModes(): LocalGameModeOption[] {
  return [
    { id: "", label: t("replays.search.mode.any") },
    { id: "custom", label: t("replays.search.mode.custom") },
    ...SIZE_BOARDS.map((board) => ({ id: board, label: leaderboardLabel(board) })),
    { id: "coop", label: t("replays.search.mode.coop") },
  ];
}

/**
 * How many played on each side, when the game had two even sides.
 *
 * `null` for anything else: a free-for-all, uneven teams, three sides, or a
 * replay whose header has not been read and so has no roster at all. None of
 * those is a size, and guessing one for them is how a filter starts lying.
 * Observers are not a side.
 */
function evenSideSize(replay: LocalReplay): number | null {
  const sides = replay.teams
    .filter((team) => team.team !== "-1" && team.team !== "null")
    .map((team) => team.players.length)
    .filter((size) => size > 0);
  if (sides.length !== 2 || sides[0] !== sides[1]) return null;
  return sides[0];
}

/** Whether a replay answers to one of the modes above. */
export function matchesLocalGameMode(replay: LocalReplay, mode: LocalGameMode): boolean {
  if (!mode) return true;
  const featuredMod = replay.modName.toLocaleLowerCase();
  if (mode === "coop") return featuredMod === COOP_FEATURED_MOD;
  if (mode === "custom") {
    return featuredMod !== COOP_FEATURED_MOD && featuredMod !== LADDER_FEATURED_MOD;
  }
  // A ladder game is a 1v1 whether or not its roster could be read, which is
  // the one size the featured mod names by itself.
  if (mode === "ladder_1v1" && featuredMod === LADDER_FEATURED_MOD) return true;
  // Co-op is a team of players against the map, so its roster is not a matchup
  // and the sizes are not about it.
  if (featuredMod === COOP_FEATURED_MOD) return false;
  return evenSideSize(replay) === SIDE_OF[mode];
}
