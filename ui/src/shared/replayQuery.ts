import type { ReplayQuery } from "../ipc/bindings";

/** Mirrors `ReplayQuery::default`: the shared unfiltered, newest-first query. */
export const EMPTY_REPLAY_QUERY: ReplayQuery = {
  player: "",
  exactPlayer: false,
  map: "",
  mapAuthor: "",
  title: "",
  replayId: "",
  host: "",
  featuredMods: [],
  leaderboards: [],
  factions: [],
  victoryConditions: [],
  minRating: null,
  maxRating: null,
  minReviewScore: null,
  maxReviewScore: null,
  minDurationMinutes: null,
  maxDurationMinutes: null,
  mapMinPlayers: null,
  mapMaxPlayers: null,
  mapMinSizeKm: null,
  mapMaxSizeKm: null,
  rankedMapOnly: false,
  after: "",
  before: "",
  onlyRanked: false,
  sortBy: "startTime",
  sortDescending: true,
  page: 1,
  pageSize: 50,
};

/**
 * The bound that means "no bound", predating FAF itself.
 *
 * The backend applies its own date floor to any narrowing search that carries no
 * `after` (`ReplayQuery::fallback_months`: three months, six with a player
 * filter). That exists to keep an unbounded query off the API's slow path, and
 * it is right by default. But a user who explicitly asks for all of history has
 * to be able to get it, and an `after` earlier than any replay is how that is
 * expressed without weakening the default.
 */
export const ALL_TIME_AFTER = "2010-01-01";

/** A date `n` days ago as `YYYY-MM-DD`, the form the search inputs use. */
export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Personal, newest-first landing query; falls back to the public feed pre-auth.
 *
 * The date bound is explicit on purpose. A player filter counts as narrowing,
 * so the backend would otherwise apply its own six-month floor
 * (`ReplayQuery::fallback_months`) and silently hide everything older, which
 * looked like the vault having only five pages. One year, matching the
 * "Recent only" toggle that now controls it: the bound is visible in the form,
 * the toggle turns it off, and an invisible floor is worse than a stated one.
 */
export function personalReplayQuery(player: string, after: string): ReplayQuery {
  return player
    ? { ...EMPTY_REPLAY_QUERY, player, exactPlayer: true, after }
    : { ...EMPTY_REPLAY_QUERY };
}

/** Number of logical filters hidden by the replay search's compact view. */
export function advancedReplayFilterCount(query: ReplayQuery): number {
  return [
    query.exactPlayer,
    query.host !== "",
    query.mapAuthor !== "",
    query.title !== "",
    query.factions.length > 0,
    query.victoryConditions.length > 0,
    query.minReviewScore !== null || query.maxReviewScore !== null,
    query.minDurationMinutes !== null || query.maxDurationMinutes !== null,
    query.mapMinPlayers !== null || query.mapMaxPlayers !== null,
    query.mapMinSizeKm !== null || query.mapMaxSizeKm !== null,
    query.rankedMapOnly,
    query.after !== "" || query.before !== "",
    query.onlyRanked,
    query.pageSize !== EMPTY_REPLAY_QUERY.pageSize,
  ].filter(Boolean).length;
}

/**
 * Whether the API will refuse to order this search the way the form asks.
 *
 * Mirrors `ReplayQuery::sort_rejected_by_api`. Elide, the framework behind
 * `/data/game`, cannot page a query that both sorts across a relationship
 * (only "review score" does) and filters across a to-many one (anything about
 * the players: name, faction, rating, leaderboard). The backend orders such a
 * search by date instead of failing it; this is what lets the form say so
 * before the user wonders why.
 */
export function reviewScoreSortUnavailable(query: ReplayQuery): boolean {
  return (
    query.sortBy === "reviewScore"
    && (query.player !== ""
      || query.leaderboards.length > 0
      || query.factions.length > 0
      || query.minRating !== null
      || query.maxRating !== null)
  );
}
