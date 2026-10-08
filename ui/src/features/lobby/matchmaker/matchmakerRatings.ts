import type { PlayerLeaguePlacement, PlayerLobbyRating, PlayerRatingSummary } from "../../../ipc/bindings";

const ratingKey = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");

function queueKeyOf(queueName: string): string {
  const rawQueueKey = ratingKey(queueName);
  // Older lobby snapshots call the full-share queue simply `tmm4v4`; the API
  // has always exposed the complete `tmm_4v4_full_share` leaderboard name.
  return rawQueueKey === "tmm4v4" ? "tmm4v4fullshare" : rawQueueKey;
}

/**
 * Match lobby queue identifiers to API leaderboard technical names.
 *
 * `live` is the player's own rating table from the lobby's `player_info`,
 * which the server sends again after every rated game. The API profile is
 * read once, when the tab first opens, so on its own it showed the rating the
 * session started with until the client was restarted (#449). Where the lobby
 * has the board, its numbers win; wins and the rest stay the profile's.
 */
export function ratingForQueue(
  ratings: PlayerRatingSummary[],
  queueName: string,
  live: readonly PlayerLobbyRating[] = [],
): PlayerRatingSummary | null {
  const queueKey = queueKeyOf(queueName);
  const fromProfile = ratings.find((rating) => ratingKey(rating.technicalName) === queueKey) ?? null;
  const fromLobby = live.find((rating) => ratingKey(rating.leaderboard) === queueKey);
  if (!fromLobby) return fromProfile;
  return {
    leaderboardId: fromProfile?.leaderboardId ?? 0,
    technicalName: fromProfile?.technicalName ?? fromLobby.leaderboard,
    wonGames: fromProfile?.wonGames ?? 0,
    updateTime: fromProfile?.updateTime ?? "",
    rating: fromLobby.rating,
    mean: fromLobby.mean,
    deviation: fromLobby.deviation,
    // Zero when the lobby left the count out, which is not a count of zero.
    gamesPlayed: fromLobby.gamesPlayed > 0 ? fromLobby.gamesPlayed : (fromProfile?.gamesPlayed ?? 0),
  };
}

/**
 * The league placement for a queue, matched the same way as the rating.
 *
 * On `technicalName`, never on `leaderboard`: that one is a display string the
 * backend rewrites for humans ("4v4 League"), and joining on it would tie
 * the division a player sees to the wording of a label.
 */
export function placementForQueue(
  placements: PlayerLeaguePlacement[],
  queueName: string,
): PlayerLeaguePlacement | null {
  const queueKey = queueKeyOf(queueName);
  return placements.find((placement) => ratingKey(placement.technicalName) === queueKey) ?? null;
}
