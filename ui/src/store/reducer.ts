// Frontend mirror of `faf-domain`'s reducer. Pure, immutable, and structurally
// identical to crates/faf-domain/src/reducer.rs — same events, same transitions.
// If you change a slice reducer in Rust, change its twin here (ARCHITECTURE.md §3.6).

import type {
  AppEvent,
  AppState,
  AuthEvent,
  AuthState,
  LobbyEvent,
  LobbyState,
  NavEvent,
  NavState,
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
    case "Lobby":
      return { ...state, lobby: reduceLobby(state.lobby, event.event) };
    case "Settings":
      return { ...state, settings: reduceSettings(state.settings, event.event) };
  }
}

function reduceSettings(state: SettingsState, event: SettingsEvent): SettingsState {
  switch (event.type) {
    case "loaded":
      return event.payload.settings;
    case "themeChanged":
      return { ...state, theme: event.payload.theme };
  }
}

function reduceNav(state: NavState, event: NavEvent): NavState {
  switch (event.type) {
    case "tabSelected":
      return { ...state, activeTab: event.payload.tab };
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
      return { ...state, status: "disconnected", games: [], join: { type: "idle" } };
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
