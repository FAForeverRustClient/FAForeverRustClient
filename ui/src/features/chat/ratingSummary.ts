import type { PlayerLobbyRating, PlayerProfile } from "../../ipc/bindings";
import { formatNumber, t } from "../../i18n";
import { LEADERBOARD_ORDER, leaderboardLabel } from "../../shared/playerRatings";

function orderedRatings(profile: PlayerProfile): PlayerLobbyRating[] {
  const ratings = profile.ratings.slice();
  // Same rule as `displayedRating`: the scalar stands in only where no table
  // arrived at all, because zero is its "not supplied" sentinel as well as a
  // rating somebody can have.
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

/** Multiline native hover summary for a chat-roster identity. */
export function rosterRatingSummary(displayName: string, profile: PlayerProfile | undefined): string {
  if (!profile) return `${displayName}\n${t("chat.rating.none")}`;
  const ratings = orderedRatings(profile);
  if (ratings.length === 0) return `${displayName}\n${t("chat.rating.unrated")}`;

  return [
    t("chat.rating.heading", { name: displayName }),
    ...ratings.map((rating) => {
      const games = rating.gamesPlayed > 0
        ? ` · ${t("chat.rating.games", { count: formatNumber(rating.gamesPlayed) })}`
        : "";
      return `${leaderboardLabel(rating.leaderboard)}: ${formatNumber(rating.rating)}${games}`;
    }),
  ].join("\n");
}
