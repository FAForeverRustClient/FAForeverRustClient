import type { PlayerProfile } from "../../ipc/bindings";
import { formatNumber, t } from "../../i18n";
import { leaderboardLabel } from "../../shared/playerRatings";
import { orderedRatings } from "./ratingRows";

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
