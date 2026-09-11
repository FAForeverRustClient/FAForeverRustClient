// Which of a player's ratings belongs beside their name, and when there is
// none to print.
//
// Two separate reports converged here.
//
// A 1v1 ladder game listed everybody's *global* rating, because that was the
// only number the client kept per player. It is the wrong one twice over: it
// is not what the game is being played for, and it is not what either player
// would tell you their rating is in that lobby. A game says which leaderboard
// it is rated on (`Game.ratingType`), so the number beside a name comes from
// that leaderboard.
//
// And "rating zero" was read as "no rating". A conservative rating is
// `mean - 3 * deviation` floored at zero, so a real, ranked, actively playing
// account whose deviation is still high displays as 0, and the client printed
// N/A for them: a player with a leaderboard entry, a rank and a profile page,
// shown as though the server had never heard of them. Worse, the one number
// that *did* count them, the game average, then disagreed with the team
// average that did not.
//
// So: an entry decides, not its value. A player with an entry for the
// leaderboard has a rating, which may be 0. A player with no entry has none,
// and that is the only N/A.

import type { PlayerLobbyRating, PlayerProfile } from "../ipc/bindings";
import { t } from "../i18n";

/** The leaderboard a custom game is rated on, and the server's default. */
export const GLOBAL_LEADERBOARD = "global";

/** A game's leaderboard, tolerating a record from before the field existed. */
export function gameLeaderboard(ratingType: string | null | undefined): string {
  return ratingType || GLOBAL_LEADERBOARD;
}

// Only "Global" is prose. The queue names are the community's own shorthand
// and stay identical in every language.
const LEADERBOARD_LABELS: Record<string, string> = {
  ladder_1v1: "1v1",
  tmm_2v2: "2v2",
  tmm_3v3: "3v3",
  tmm_4v4: "4v4",
};

/** How a leaderboard is named in the UI: "Global", "1v1", "2v2", ... */
export function leaderboardLabel(technicalName: string): string {
  if (technicalName === GLOBAL_LEADERBOARD) return t("chat.rating.global");
  return (
    LEADERBOARD_LABELS[technicalName]
    ?? technicalName.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

/** The order the leaderboards are listed in, global first then by team size. */
export const LEADERBOARD_ORDER = ["global", "ladder_1v1", "tmm_2v2", "tmm_3v3", "tmm_4v4"];

function entryFor(
  profile: PlayerProfile,
  leaderboard: string,
): PlayerLobbyRating | undefined {
  return profile.ratings.find((rating) => rating.leaderboard === leaderboard);
}

/**
 * The rating to print for `profile` on `leaderboard`, or `null` when this
 * player has never been rated there.
 *
 * `globalRating` is the fallback for the global board alone, and only for a
 * profile whose rating table never arrived: some incremental `player_info`
 * payloads carry the scalar and nothing else. It is deliberately not a
 * fallback for a queue leaderboard: answering "what is their 1v1 rating" with
 * their global one is the bug this function exists to stop.
 */
export function displayedRating(
  profile: PlayerProfile | undefined,
  leaderboard: string = GLOBAL_LEADERBOARD,
): number | null {
  if (!profile) return null;
  const entry = entryFor(profile, leaderboard);
  if (entry) return entry.rating;
  if (leaderboard === GLOBAL_LEADERBOARD && profile.globalRating > 0) {
    return profile.globalRating;
  }
  return null;
}
