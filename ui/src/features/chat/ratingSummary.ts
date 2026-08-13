import type { PlayerLobbyRating, PlayerProfile } from "../../ipc/bindings";

const RATING_LABELS: Record<string, string> = {
  global: "Global",
  ladder_1v1: "1v1",
  tmm_2v2: "2v2",
  tmm_3v3: "3v3",
  tmm_4v4: "4v4",
};

const RATING_ORDER = ["global", "ladder_1v1", "tmm_2v2", "tmm_3v3", "tmm_4v4"];

function ratingLabel(technicalName: string): string {
  return RATING_LABELS[technicalName]
    ?? technicalName
      .replace(/_/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function orderedRatings(profile: PlayerProfile): PlayerLobbyRating[] {
  const ratings = profile.ratings.slice();
  if (profile.globalRating > 0 && !ratings.some((rating) => rating.leaderboard === "global")) {
    ratings.push({
      leaderboard: "global",
      rating: profile.globalRating,
      mean: 0,
      deviation: 0,
      gamesPlayed: 0,
    });
  }
  return ratings.sort((left, right) => {
    const leftRank = RATING_ORDER.indexOf(left.leaderboard);
    const rightRank = RATING_ORDER.indexOf(right.leaderboard);
    return (leftRank < 0 ? RATING_ORDER.length : leftRank)
      - (rightRank < 0 ? RATING_ORDER.length : rightRank)
      || left.leaderboard.localeCompare(right.leaderboard);
  });
}

/** Multiline native hover summary for a chat-roster identity. */
export function rosterRatingSummary(displayName: string, profile: PlayerProfile | undefined): string {
  if (!profile) return `${displayName}\nNo FAF rating data available`;
  const ratings = orderedRatings(profile);
  if (ratings.length === 0) return `${displayName}\nUnrated`;

  return [
    `${displayName}: ratings`,
    ...ratings.map((rating) => {
      const games = rating.gamesPlayed > 0 ? ` · ${rating.gamesPlayed.toLocaleString("en-US")} games` : "";
      return `${ratingLabel(rating.leaderboard)}: ${rating.rating.toLocaleString("en-US")}${games}`;
    }),
  ].join("\n");
}
