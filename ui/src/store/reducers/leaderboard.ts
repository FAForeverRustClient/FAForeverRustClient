import type { LeaderboardEvent, LeaderboardState } from "../../ipc/bindings";

export function reduceLeaderboard(
  state: LeaderboardState,
  event: LeaderboardEvent,
): LeaderboardState {
  switch (event.type) {
    case "modeChanged":
      return { ...state, mode: event.payload.mode };
    case "catalogLoading":
      return { ...state, catalogStatus: { type: "loading" } };
    case "catalogLoaded":
      return {
        ...state,
        ratingLeaderboards: event.payload.ratingLeaderboards,
        leagues: event.payload.leagues,
        catalogStatus: { type: "ready" },
      };
    case "catalogLoadFailed":
      return {
        ...state,
        catalogStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "ratingsLoading":
      return {
        ...state,
        ratingQuery: event.payload.query,
        ratingsStatus: { type: "loading" },
      };
    case "ratingsLoaded":
      return {
        ...state,
        ratingQuery: event.payload.query,
        ratingPage: event.payload.page,
        ratingsStatus: { type: "ready" },
      };
    case "ratingsLoadFailed":
      return {
        ...state,
        ratingsStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "seasonsLoading":
      return {
        ...state,
        selectedLeagueId: event.payload.leagueId,
        seasons: [],
        seasonsStatus: { type: "loading" },
        selectedSeasonId: null,
        seasonEntries: [],
        tiers: [],
      };
    case "seasonsLoaded":
      return {
        ...state,
        selectedLeagueId: event.payload.leagueId,
        seasons: event.payload.seasons,
        seasonsStatus: { type: "ready" },
      };
    case "seasonsLoadFailed":
      return {
        ...state,
        seasonsStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "seasonLoading":
      return {
        ...state,
        selectedSeasonId: event.payload.seasonId,
        seasonStatus: { type: "loading" },
      };
    case "seasonLoaded":
      return {
        ...state,
        selectedSeasonId: event.payload.seasonId,
        seasonEntries: event.payload.leaderboard.entries,
        tiers: event.payload.leaderboard.tiers,
        seasonStatus: { type: "ready" },
      };
    case "seasonLoadFailed":
      return {
        ...state,
        seasonStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
  }
}
