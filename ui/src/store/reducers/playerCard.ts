import type { PlayerCardEvent, PlayerCardState, RatingHistoryPoint } from "../../ipc/bindings";

function mergeHistory(current: RatingHistoryPoint[], incoming: RatingHistoryPoint[]): RatingHistoryPoint[] {
  const byTime = new Map(current.map((point) => [point.timestamp, point]));
  for (const point of incoming) byTime.set(point.timestamp, point);
  return [...byTime.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function reducePlayerCard(state: PlayerCardState, event: PlayerCardEvent): PlayerCardState {
  switch (event.type) {
    case "loading":
      return {
        ...state,
        open: true,
        requestedLogin: event.payload.login,
        profile: null,
        profileStatus: "loading",
        profileError: "",
        historyQuery: null,
        history: [],
        historyMaximum: null,
        historyStatus: "idle",
      };
    case "loaded":
      return {
        ...state,
        requestedLogin: event.payload.profile.login,
        profile: event.payload.profile,
        profileStatus: "ready",
      };
    case "loadFailed":
      return { ...state, profileStatus: "failed", profileError: event.payload.reason };
    case "closed":
      return { ...state, open: false, profileStatus: "idle", historyStatus: "idle" };
    case "historyLoading":
      return {
        ...state,
        historyQuery: event.payload.query,
        historyStatus: "loading",
        historyError: "",
        history: event.payload.append ? state.history : [],
        historyMaximum: event.payload.append ? state.historyMaximum : null,
        historyPage: event.payload.append ? state.historyPage : 0,
        historyTotalPages: event.payload.append ? state.historyTotalPages : 1,
      };
    case "historyLoaded":
      return {
        ...state,
        historyQuery: event.payload.query,
        history: event.payload.append
          ? mergeHistory(state.history, event.payload.page.points)
          : mergeHistory([], event.payload.page.points),
        historyMaximum: event.payload.page.maximum ?? (event.payload.append ? state.historyMaximum : null),
        historyPage: event.payload.page.page,
        historyTotalPages: Math.max(1, event.payload.page.totalPages),
        historyStatus: "ready",
      };
    case "historyLoadFailed":
      return { ...state, historyStatus: "failed", historyError: event.payload.reason };
    case "avatarSelected": {
      let profile = state.profile;
      if (profile?.playerId === event.payload.playerId) {
        const avatars = profile.avatars.map((avatar) => ({
          ...avatar,
          selected: event.payload.url === avatar.url,
        }));
        if (event.payload.url && !avatars.some((avatar) => avatar.url === event.payload.url)) {
          avatars.push({
            url: event.payload.url,
            tooltip: event.payload.tooltip,
            selected: true,
            expiresAt: null,
          });
        }
        profile = { ...profile, avatars };
      }
      const matchmakerProfile = state.matchmakerProfile?.playerId === event.payload.playerId
        ? {
            ...state.matchmakerProfile,
            avatarUrl: event.payload.url ?? "",
            avatarTooltip: event.payload.tooltip,
          }
        : state.matchmakerProfile;
      return { ...state, profile, matchmakerProfile };
    }
    case "matchmakerProfileLoading":
      return {
        ...state,
        matchmakerProfile: state.matchmakerProfile?.playerId === event.payload.playerId
          ? state.matchmakerProfile
          : null,
        matchmakerProfileStatus: "loading",
        matchmakerProfileError: "",
      };
    case "matchmakerProfileLoaded":
      return {
        ...state,
        matchmakerProfile: event.payload.profile,
        matchmakerProfileStatus: "ready",
        matchmakerProfileError: "",
      };
    case "matchmakerProfileLoadFailed":
      return {
        ...state,
        matchmakerProfile: state.matchmakerProfile?.playerId === event.payload.playerId
          ? state.matchmakerProfile
          : null,
        matchmakerProfileStatus: "failed",
        matchmakerProfileError: event.payload.reason,
      };
  }
}
