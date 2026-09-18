// The rating table behind a roster hover, as data rather than as a string.
//
// These used to be folded into the newline-separated text a native `title`
// attribute wants, which is how every rating summary in chat was shown until
// the hover card (see `PlayerRatingCard`) replaced it. The rows are the shape
// the card wants; a card built by splitting a tooltip string back apart is one
// that breaks the first time a leaderboard name contains a colon.

import type { PlayerLobbyRating, PlayerProfile } from "../../../ipc/bindings";
import { LEADERBOARD_ORDER } from "../../../shared/playerRatings";

/**
 * Every rating the profile carries, in the order the leaderboard tab uses.
 *
 * The scalar `globalRating` stands in only where no table arrived at all: zero
 * is its "not supplied" sentinel as well as a rating somebody can have, so it
 * cannot be distinguished from a missing value on its own.
 */
export function orderedRatings(profile: PlayerProfile): PlayerLobbyRating[] {
  const ratings = profile.ratings.slice();
  if (ratings.length === 0 && profile.globalRating !== 0) {
    ratings.push({
      leaderboard: "global",
      rating: profile.globalRating,
      mean: 0,
      deviation: 0,
      gamesPlayed: 0,
    });
  }
  return ratings.sort((left, right) => {
    const leftRank = LEADERBOARD_ORDER.indexOf(left.leaderboard);
    const rightRank = LEADERBOARD_ORDER.indexOf(right.leaderboard);
    return (leftRank < 0 ? LEADERBOARD_ORDER.length : leftRank)
      - (rightRank < 0 ? LEADERBOARD_ORDER.length : rightRank)
      || left.leaderboard.localeCompare(right.leaderboard);
  });
}
