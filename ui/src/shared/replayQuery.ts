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

/** Personal, newest-first landing query; falls back to the public feed pre-auth. */
export function personalReplayQuery(player: string): ReplayQuery {
  return player
    ? { ...EMPTY_REPLAY_QUERY, player, exactPlayer: true }
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
