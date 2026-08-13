// Frontend mirror of `faf-domain`'s reducer. Pure, immutable, and structurally
// identical to crates/faf-domain/src/reducer.rs — same events, same transitions.
// If you change a slice reducer in Rust, change its twin here (ARCHITECTURE.md §3.6).

import type {
  AppEvent,
  AppState,
  AuthEvent,
  AuthState,
  ChatEvent,
  ChatState,
  LeaderboardEvent,
  LeaderboardState,
  LobbyEvent,
  LobbyState,
  MapsEvent,
  MapsState,
  ModsEvent,
  ModsState,
  NavEvent,
  NavState,
  ReplayEvent,
  ReplayState,
  SessionEvent,
  SessionState,
  SettingsEvent,
  SettingsState,
} from "../ipc/bindings";

export function applyEvent(state: AppState, event: AppEvent): AppState {
  switch (event.kind) {
    case "Session":
      return { ...state, session: reduceSession(state.session, event.event) };
    case "Auth":
      return { ...state, auth: reduceAuth(state.auth, event.event) };
    case "Nav":
      return { ...state, nav: reduceNav(state.nav, event.event) };
    case "Chat":
      return { ...state, chat: reduceChat(state.chat, event.event) };
    case "Lobby":
      return { ...state, lobby: reduceLobby(state.lobby, event.event) };
    case "Replays":
      return { ...state, replays: reduceReplays(state.replays, event.event) };
    case "Maps":
      return { ...state, maps: reduceMaps(state.maps, event.event) };
    case "Mods":
      return { ...state, mods: reduceMods(state.mods, event.event) };
    case "Leaderboard":
      return { ...state, leaderboard: reduceLeaderboard(state.leaderboard, event.event) };
    case "Settings":
      return { ...state, settings: reduceSettings(state.settings, event.event) };
  }
}

function reduceMods(state: ModsState, event: ModsEvent): ModsState {
  switch (event.type) {
    case "vaultLoading":
      return { ...state, vaultStatus: { type: "loading" } };
    case "vaultLoaded":
      return { ...state, vault: event.payload.mods, vaultStatus: { type: "ready" } };
    case "vaultLoadFailed":
      return { ...state, vaultStatus: { type: "failed", payload: { reason: event.payload.reason } } };
    case "installedLoading":
      return { ...state, installedStatus: { type: "loading" } };
    case "installedLoaded":
      return { ...state, installed: event.payload.mods, installedStatus: { type: "ready" } };
    case "installedLoadFailed":
      return {
        ...state,
        installedStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "installing":
      return {
        ...state,
        installStatus: { type: "installing", payload: { uid: event.payload.uid } },
      };
    case "installed":
      return {
        ...state,
        installed: event.payload.installed,
        installedStatus: { type: "ready" },
        installStatus: { type: "idle" },
      };
    case "installFailed":
      return { ...state, installStatus: { type: "failed", payload: { reason: event.payload.reason } } };
    case "uninstalled":
      return {
        ...state,
        installed: event.payload.installed,
        installedStatus: { type: "ready" },
        installStatus: { type: "idle" },
      };
    case "uninstallFailed":
      return { ...state, installStatus: { type: "failed", payload: { reason: event.payload.reason } } };
    case "toggling":
      return {
        ...state,
        toggleStatus: { type: "toggling", payload: { uid: event.payload.uid } },
      };
    case "toggled":
      return {
        ...state,
        installed: event.payload.installed,
        installedStatus: { type: "ready" },
        toggleStatus: { type: "idle" },
      };
    case "toggleFailed":
      return { ...state, toggleStatus: { type: "failed", payload: { reason: event.payload.reason } } };
  }
}

function reduceLeaderboard(state: LeaderboardState, event: LeaderboardEvent): LeaderboardState {
  switch (event.type) {
    case "leaguesLoading":
      return { ...state, leaguesStatus: { type: "loading" } };
    case "leaguesLoaded":
      return { ...state, leagues: event.payload.leagues, leaguesStatus: { type: "ready" } };
    case "leaguesLoadFailed":
      return {
        ...state,
        leaguesStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "entriesLoading":
      return {
        ...state,
        selectedLeagueId: event.payload.leagueId,
        entriesStatus: { type: "loading" },
      };
    case "entriesLoaded":
      return {
        ...state,
        selectedLeagueId: event.payload.leagueId,
        entries: event.payload.entries,
        entriesStatus: { type: "ready" },
      };
    case "entriesLoadFailed":
      return {
        ...state,
        entriesStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "globalLoading":
      return { ...state, globalStatus: { type: "loading" } };
    case "globalLoaded":
      return { ...state, globalEntries: event.payload.entries, globalStatus: { type: "ready" } };
    case "globalLoadFailed":
      return {
        ...state,
        globalStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
  }
}

function reduceMaps(state: MapsState, event: MapsEvent): MapsState {
  switch (event.type) {
    case "vaultLoading":
      return { ...state, vaultStatus: { type: "loading" } };
    case "vaultLoaded":
      return { ...state, vault: event.payload.maps, vaultStatus: { type: "ready" } };
    case "vaultLoadFailed":
      return { ...state, vaultStatus: { type: "failed", payload: { reason: event.payload.reason } } };
    case "installedLoading":
      return { ...state, installedStatus: { type: "loading" } };
    case "installedLoaded":
      return { ...state, installed: event.payload.maps, installedStatus: { type: "ready" } };
    case "installedLoadFailed":
      return {
        ...state,
        installedStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "installing":
      return {
        ...state,
        installStatus: { type: "installing", payload: { folderName: event.payload.folderName } },
      };
    case "installed":
      return {
        ...state,
        installed: event.payload.installed,
        installedStatus: { type: "ready" },
        installStatus: { type: "idle" },
      };
    case "installFailed":
      return { ...state, installStatus: { type: "failed", payload: { reason: event.payload.reason } } };
    case "uninstalled":
      return {
        ...state,
        installed: event.payload.installed,
        installedStatus: { type: "ready" },
        installStatus: { type: "idle" },
      };
    case "uninstallFailed":
      return { ...state, installStatus: { type: "failed", payload: { reason: event.payload.reason } } };
  }
}

function reduceSettings(state: SettingsState, event: SettingsEvent): SettingsState {
  switch (event.type) {
    case "loaded":
      return event.payload.settings;
    case "themeChanged":
      return { ...state, theme: event.payload.theme };
    case "gamePathChanged":
      return { ...state, gamePath: event.payload.path };
    case "replayGamePathChanged":
      return { ...state, replayGamePath: event.payload.path };
  }
}

function reduceNav(state: NavState, event: NavEvent): NavState {
  switch (event.type) {
    case "tabSelected":
      return { ...state, activeTab: event.payload.tab };
  }
}

function reduceChat(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "connecting":
      return { ...state, status: "connecting" };
    case "connected":
      return { ...state, status: "connected" };
    case "messageReceived":
      return { ...state, messages: [...state.messages, event.payload.message] };
    case "usersUpdated":
      return { ...state, users: event.payload.users };
    case "disconnected":
      return { ...state, status: "disconnected", users: [] };
  }
}

function reduceLobby(state: LobbyState, event: LobbyEvent): LobbyState {
  switch (event.type) {
    case "connecting":
      return { ...state, status: "connecting" };
    case "connected":
      return { ...state, status: "connected" };
    case "gamesUpdated":
      return { ...state, games: event.payload.games };
    case "liveGamesUpdated":
      return { ...state, liveGames: event.payload.games };
    case "joining":
      return { ...state, join: { type: "joining", payload: { id: event.payload.id } } };
    case "launching":
      return { ...state, join: { type: "launched", payload: { launch: event.payload.launch } } };
    case "joinFailed":
      return {
        ...state,
        join: { type: "failed", payload: { id: event.payload.id, reason: event.payload.reason } },
      };
    case "inGame":
      return { ...state, join: { type: "inGame" } };
    case "launchFailed":
      return { ...state, join: { type: "launchFailed", payload: { reason: event.payload.reason } } };
    case "disconnected":
      return {
        ...state,
        status: "disconnected",
        games: [],
        liveGames: [],
        join: { type: "idle" },
        host: { type: "idle" },
        ratings: {},
      };
    case "hosting":
      return { ...state, host: { type: "hosting" } };
    case "hosted":
      return { ...state, host: { type: "hosted", payload: { id: event.payload.id } } };
    case "hostFailed":
      return { ...state, host: { type: "failed", payload: { reason: event.payload.reason } } };
    case "playerRatingsUpdated": {
      const ratings = { ...state.ratings };
      for (const r of event.payload.ratings) ratings[r.login] = r.rating;
      return { ...state, ratings };
    }
  }
}

function reduceReplays(state: ReplayState, event: ReplayEvent): ReplayState {
  switch (event.type) {
    case "connecting":
      return { ...state, status: { type: "connecting" }, lastWarning: null };
    case "playing":
      return {
        ...state,
        status: { type: "playing", payload: { uid: event.payload.uid } },
        lastWarning: event.payload.warning,
      };
    case "failed":
      return { ...state, status: { type: "failed", payload: { reason: event.payload.reason } } };
    case "closed":
      return { ...state, status: { type: "idle" } };
    case "vaultLoading":
      return { ...state, vaultStatus: { type: "loading" } };
    case "vaultLoaded":
      return { ...state, vault: event.payload.replays, vaultStatus: { type: "ready" } };
    case "vaultLoadFailed":
      return {
        ...state,
        vaultStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
    case "localLoading":
      return { ...state, localStatus: { type: "loading" } };
    case "localLoaded":
      return { ...state, local: event.payload.replays, localStatus: { type: "ready" } };
    case "localLoadFailed":
      return {
        ...state,
        localStatus: { type: "failed", payload: { reason: event.payload.reason } },
      };
  }
}

function reduceAuth(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "loginStarted":
      return { ...state, status: "loggingIn", error: null };
    case "loggedIn":
      return { ...state, status: "loggedIn", player: event.payload.player, error: null };
    case "loginFailed":
      return { ...state, status: "failed", player: null, error: event.payload.message };
    case "loggedOut":
      return { ...state, status: "loggedOut", player: null, error: null };
  }
}

function reduceSession(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "connecting":
      return { ...state, status: "connecting" };
    case "backendReady":
      return { ...state, status: "connected", backendVersion: event.payload.version };
    case "disconnected":
      return { ...state, status: "disconnected", backendVersion: "" };
  }
}
