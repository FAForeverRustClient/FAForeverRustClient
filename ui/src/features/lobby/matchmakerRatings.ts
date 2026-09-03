import type { PlayerLeaguePlacement, PlayerRatingSummary } from "../../ipc/bindings";

const ratingKey = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");

/** Match lobby queue identifiers to API leaderboard technical names. */
export function ratingForQueue(ratings: PlayerRatingSummary[], queueName: string): PlayerRatingSummary | null {
  const rawQueueKey = ratingKey(queueName);
  // Older lobby snapshots call the full-share queue simply `tmm4v4`; the API
  // has always exposed the complete `tmm_4v4_full_share` leaderboard name.
  const queueKey = rawQueueKey === "tmm4v4" ? "tmm4v4fullshare" : rawQueueKey;
  return ratings.find((rating) => ratingKey(rating.technicalName) === queueKey) ?? null;
}

/**
 * The league placement for a queue, matched the same way as the rating.
 *
 * On `technicalName`, never on `leaderboard`: that one is a display string the
 * backend rewrites for humans ("4v4 Full Share"), and joining on it would tie
 * the division a player sees to the wording of a label.
 */
export function placementForQueue(
  placements: PlayerLeaguePlacement[],
  queueName: string,
): PlayerLeaguePlacement | null {
  const rawQueueKey = ratingKey(queueName);
  const queueKey = rawQueueKey === "tmm4v4" ? "tmm4v4fullshare" : rawQueueKey;
  return placements.find((placement) => ratingKey(placement.technicalName) === queueKey) ?? null;
}
