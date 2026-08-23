import type { MatchmakerQueue, PlayerRatingSummary } from "../../ipc/bindings";

const ratingKey = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]/g, "");

/** Match lobby queue identifiers to API leaderboard technical names. */
export function ratingForQueue(ratings: PlayerRatingSummary[], queueName: string): PlayerRatingSummary | null {
  const rawQueueKey = ratingKey(queueName);
  // Older lobby snapshots call the full-share queue simply `tmm4v4`; the API
  // has always exposed the complete `tmm_4v4_full_share` leaderboard name.
  const queueKey = rawQueueKey === "tmm4v4" ? "tmm4v4fullshare" : rawQueueKey;
  return ratings.find((rating) => ratingKey(rating.technicalName) === queueKey) ?? null;
}

export type QueueProximity = "near" | "far" | "unknown";

/**
 * Whether anybody currently searching a queue is close enough in rating to be
 * matched with you.
 *
 * `"unknown"` is a real answer and not a failure: an unrated player has no
 * number to compare, and a populated queue whose brackets the server did not
 * publish tells us nothing. Neither may be presented as "nobody is near you".
 *
 * Mirrors `MatchmakerQueue::has_opponent_near` in
 * `crates/faf-domain/src/state/lobby.rs`, which documents why the deviation
 * picks the bracket set, and why the comparison is against the mean rather than
 * the displayed rating. Kept here because it needs the signed-in player's
 * rating, which lives in a different state slice than the queue: no Rust
 * reducer sees both.
 */
export function opponentsNearYou(queue: MatchmakerQueue, rating: PlayerRatingSummary | null): QueueProximity {
  // An unrated player, or one the API reports without the raw numbers, has
  // nothing to compare: say so rather than answering "nobody".
  if (!rating || rating.mean === null || rating.deviation === null) return "unknown";
  const brackets = (rating.deviation < 100 ? queue.ratingBrackets80 : queue.ratingBrackets75) ?? [];
  if (brackets.length === 0) return queue.numPlayers > 0 ? "unknown" : "far";
  const mean = Math.round(rating.mean);
  return brackets.some((bracket) => mean >= bracket.min && mean <= bracket.max) ? "near" : "far";
}
