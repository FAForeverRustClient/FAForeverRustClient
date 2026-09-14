// "Which mode was this played in", for a file on disk, in the same words the
// online tab uses: custom games, ladder, co-op. Not featured mod names.
//
// The two are different questions and the first version of this control
// conflated them, offering `fafbeta` and `fafdevelop` as though they were
// modes. They are not: a game on the beta build is a custom game that happens
// to have been played on a different build of the same mod. The online tab
// keeps the featured mod in the advanced panel for exactly that reason, and so
// does this one now.
//
// What a `.fafreplay` can be classified by is its envelope's `featured_mod`,
// and that answers three of the modes outright:
//
//   coop        -> co-op
//   ladder1v1   -> ladder 1v1
//   everything  -> a custom game
//
// **The matchmaker sizes are not in the file.** A 3v3 played through the
// matchmaker and a 3v3 somebody hosted are both `faf` in the envelope, and
// nothing else in it says which. `game_type` looks like it should: the lobby
// sets it to `matchmaker` or `custom` when this client records a game. But a
// replay downloaded from the vault carries the *victory condition* there
// instead -- DEMORALIZATION, DOMINATION, SANDBOX, UNKNOWN -- so the field
// means two different things depending on who wrote the file, and a filter
// cannot be built on it. Offering 2v2/3v3/4v4 here would therefore be a
// claim this client cannot support; a filter on how many played is a separate
// and answerable question.

import { t } from "../../i18n";
import { leaderboardLabel } from "../../shared/playerRatings";

/** The featured mod a co-op game carries. */
const COOP_FEATURED_MOD = "coop";
/** The featured mod a ladder game carries; the leaderboard spells it with an underscore. */
const LADDER_FEATURED_MOD = "ladder1v1";

/** Empty is "any mode". */
export type LocalGameMode = "" | "custom" | "ladder" | "coop";

export interface LocalGameModeOption {
  id: LocalGameMode;
  label: string;
}

/**
 * The modes to offer.
 *
 * A fixed list, unlike the featured-mod picker this replaces: these are the
 * questions a replay file can answer, whether or not this particular archive
 * happens to contain one of each. An empty "Co-op" result is a fact about the
 * archive; a missing Co-op entry would look like a fact about the client.
 */
export function localGameModes(): LocalGameModeOption[] {
  return [
    { id: "", label: t("replays.search.mode.any") },
    { id: "custom", label: t("replays.search.mode.custom") },
    { id: "ladder", label: leaderboardLabel("ladder_1v1") },
    { id: "coop", label: t("replays.search.mode.coop") },
  ];
}

/** Which mode a replay's featured mod puts it in. */
export function localGameModeOf(featuredMod: string): Exclude<LocalGameMode, ""> {
  switch (featuredMod.toLocaleLowerCase()) {
    case COOP_FEATURED_MOD: return "coop";
    case LADDER_FEATURED_MOD: return "ladder";
    default: return "custom";
  }
}
