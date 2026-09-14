// "Which mode was this played in", for a file on disk.
//
// The online tab asks this as a game mode picker, built from the API's rating
// leaderboards; a local replay has no such thing. What a `.fafreplay` carries
// is the featured mod its envelope was written with, and for the modes anyone
// filters by that is the same question under a different name: `coop` is a
// co-op game, `ladder1v1` is a ladder game, and `faf` is everything else.
//
// So this is one control on one field rather than the online tab's two. A
// second, free-text mod box beside it would write the same `mod` filter, and
// the only thing the reader could do with the pair is contradict themselves
// into an empty list.
//
// What it cannot answer is which matchmaker queue a team game came from: a
// 3v3 through the matchmaker and a 3v3 somebody hosted are both `faf` in the
// envelope, and the queue is not written down anywhere in the file. The list
// is therefore built from the mods the archive actually contains, so it offers
// exactly the distinctions the files on this disk can be told apart by.

import { t } from "../../i18n";
import { leaderboardLabel } from "../../shared/playerRatings";

/** The featured mod every custom game carries. */
export const CUSTOM_FEATURED_MOD = "faf";
/** The featured mod a co-op game carries. */
export const COOP_FEATURED_MOD = "coop";
/** The featured mod a ladder game carries; the leaderboard spells it with an underscore. */
const LADDER_FEATURED_MOD = "ladder1v1";

export interface LocalGameMode {
  /** The `<option>` value, matched against `LocalReplay.modName`. Empty is "any". */
  id: string;
  label: string;
}

/**
 * A featured mod under the name a player would use for it.
 *
 * Anything this does not recognise keeps its own name: `nomads`, `murderparty`
 * and the rest are mods, and a mod's name is the mod's, not ours to reword.
 */
export function localGameModeLabel(featuredMod: string): string {
  switch (featuredMod) {
    case CUSTOM_FEATURED_MOD: return t("replays.search.mode.custom");
    case COOP_FEATURED_MOD: return t("replays.search.mode.coop");
    case LADDER_FEATURED_MOD: return leaderboardLabel("ladder_1v1");
    default: return featuredMod;
  }
}

/**
 * The modes to offer for an archive containing these featured mods.
 *
 * Sorted with the two everybody has first and the rest alphabetically, so the
 * list does not reorder itself as the archive grows.
 */
export function localGameModes(featuredMods: string[]): LocalGameMode[] {
  const known = [CUSTOM_FEATURED_MOD, COOP_FEATURED_MOD, LADDER_FEATURED_MOD]
    .filter((mod) => featuredMods.includes(mod));
  const rest = featuredMods
    .filter((mod) => mod && !known.includes(mod))
    .sort((left, right) => left.localeCompare(right));
  return [
    { id: "", label: t("replays.search.mode.any") },
    ...[...known, ...rest].map((mod) => ({ id: mod, label: localGameModeLabel(mod) })),
  ];
}
