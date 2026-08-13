import type { PlayerRatingSummary } from "../../ipc/bindings";

const ratingKey = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");

/** Match lobby queue identifiers to API leaderboard technical names. */
export function ratingForQueue(ratings: PlayerRatingSummary[], queueName: string): PlayerRatingSummary | null {
  const rawQueueKey = ratingKey(queueName);
  // Older lobby snapshots call the full-share queue simply `tmm4v4`; the API
  // has always exposed the complete `tmm_4v4_full_share` leaderboard name.
  const queueKey = rawQueueKey === "tmm4v4" ? "tmm4v4fullshare" : rawQueueKey;
  return ratings.find((rating) => ratingKey(rating.technicalName) === queueKey) ?? null;
}
