// "Which mode was this played in", for a file on disk.
//
// Three of the online tab's modes and not the rest, because the rest are not
// in the file. This is the deliberate part, so it is written down here rather
// than left to be rediscovered.
//
// ## What a replay says, and what it does not
//
// The envelope names the featured mod, and that answers three modes outright:
// `coop` is a co-op game, `ladder1v1` is a ladder game, everything else is a
// custom game. `fafbeta` and `fafdevelop` are custom games on another build,
// not modes of their own -- the featured mod filter in the advanced panel is
// how you ask for those, exactly as the online tab keeps it.
//
// **The matchmaker sizes are not offered, because nothing in the file says
// which queue a game came from.** Three places could have:
//
//   - `featured_mod` is `faf` for every TMM game, 2v2 through 4v4 alike.
//   - `game_type` looks right -- the lobby writes `matchmaker` or `custom`
//     there when this client records a game -- but a replay downloaded from
//     the vault carries the *victory condition* in the same field
//     (DEMORALIZATION, DOMINATION, SANDBOX, UNKNOWN across 93 files of a real
//     archive). One field, two meanings, depending on who wrote it.
//   - the sim's own game options table, fifty-odd keys including `Ratings`,
//     `Quality` and `Unranked`, names neither queue nor leaderboard.
//
// Reading the sizes off the roster instead -- two even sides of three is a
// 3v3 -- was tried and withdrawn: it answers a different question, because a
// hosted 3v3 and a matchmaker 3v3 are indistinguishable that way, and 1v1
// through 4v4 mean the matchmaker everywhere else in this client.
//
// The online tab has them because it does not answer the question itself: it
// sends `playerStats.ratingChanges.leaderboard.technicalName == <board>` to
// the API and lets the server answer. Doing the same here means a server
// lookup per local game, which is a feature rather than a filter, and is not
// what this is.

import type { LocalReplay } from "../../ipc/bindings";
import { t } from "../../i18n";
import { leaderboardLabel } from "../../shared/playerRatings";

/** The featured mod a co-op game carries. */
const COOP_FEATURED_MOD = "coop";
/** The featured mod a ladder game carries; the leaderboard spells it with an underscore. */
const LADDER_FEATURED_MOD = "ladder1v1";

/** Empty is "any mode", the default. */
export type LocalGameMode = "" | "custom" | "ladder_1v1" | "coop";

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
 *
 * `leaderboardLabel` writes the ladder's name, so it reads the same here as it
 * does in the vault picker and beside every rating in the client, and a board
 * FAF renames is renamed in all of them at once.
 */
export function localGameModes(): LocalGameModeOption[] {
  return [
    { id: "", label: t("replays.search.mode.any") },
    { id: "custom", label: t("replays.search.mode.custom") },
    { id: "ladder_1v1", label: leaderboardLabel("ladder_1v1") },
    { id: "coop", label: t("replays.search.mode.coop") },
  ];
}

/** Whether a replay answers to one of the modes above. */
export function matchesLocalGameMode(replay: LocalReplay, mode: LocalGameMode): boolean {
  if (!mode) return true;
  const featuredMod = replay.modName.toLocaleLowerCase();
  switch (mode) {
    case "coop": return featuredMod === COOP_FEATURED_MOD;
    case "ladder_1v1": return featuredMod === LADDER_FEATURED_MOD;
    // Every other build of the base mod included: a game on the beta build is
    // a custom game that happened to be played on a different build.
    case "custom":
      return featuredMod !== COOP_FEATURED_MOD && featuredMod !== LADDER_FEATURED_MOD;
  }
}
