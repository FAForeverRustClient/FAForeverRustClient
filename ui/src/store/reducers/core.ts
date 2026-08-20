import type {
  AuthEvent,
  AuthState,
  InstallEvent,
  InstallState,
  NavEvent,
  NavState,
  SessionEvent,
  SessionState,
  SettingsEvent,
  SettingsState,
} from "../../ipc/bindings";
import { normalizePlayerNotes } from "../../shared/playerNotes";
import { normalizeBrowsingPreferences } from "../../shared/browsingPreferences";

export function reduceSettings(state: SettingsState, event: SettingsEvent): SettingsState {
  switch (event.type) {
    case "loaded":
      return event.payload.settings;
    case "themeChanged":
      return { ...state, theme: event.payload.theme };
    case "gamePathChanged":
      return { ...state, gamePath: event.payload.path };
    case "replayGamePathChanged":
      return { ...state, replayGamePath: event.payload.path };
    case "generalChanged":
      return { ...state, general: event.payload.preferences };
    case "appearanceChanged":
      return { ...state, appearance: event.payload.preferences };
    case "socialChanged":
      return {
        ...state,
        social: {
          ...event.payload.preferences,
          playerNotes: normalizePlayerNotes(event.payload.preferences.playerNotes),
        },
      };
    case "notificationsChanged":
      return { ...state, notifications: event.payload.preferences };
    case "chatChanged":
      return { ...state, chat: event.payload.preferences };
    case "gameChanged":
      return { ...state, game: event.payload.preferences };
    case "discordChanged":
      return { ...state, discord: event.payload.preferences };
    case "connectivityChanged":
      return { ...state, connectivity: event.payload.preferences };
    case "updatesChanged":
      return { ...state, updates: event.payload.preferences };
    case "browsingChanged":
      return { ...state, browsing: normalizeBrowsingPreferences(event.payload.preferences) };
    case "mapGeneratorChanged":
      return { ...state, mapGenerator: event.payload.preferences };
  }
}

export function reduceNav(state: NavState, event: NavEvent): NavState {
  switch (event.type) {
    case "tabSelected":
      return { ...state, activeTab: event.payload.tab };
  }
}

export function reduceInstall(_state: InstallState, event: InstallEvent): InstallState {
  switch (event.type) {
    case "checked":
      return {
        gameReady: event.payload.gameReady,
        replayReady: event.payload.replayReady,
        checked: true,
      };
  }
}

export function reduceAuth(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "loginStarted":
      return { ...state, status: "loggingIn", error: null };
    case "restoreStarted":
      return { ...state, status: "restoring", error: null };
    case "loggedIn":
      return { ...state, status: "loggedIn", player: event.payload.player, error: null, mode: "account" };
    case "testLoggedIn":
      return { ...state, status: "loggedIn", player: event.payload.player, error: null, mode: "test" };
    case "loginFailed":
      return { ...state, status: "failed", player: null, error: event.payload.message };
    case "loggedOut":
      return { ...state, status: "loggedOut", player: null, error: null, mode: "account" };
  }
}

export function reduceSession(state: SessionState, event: SessionEvent): SessionState {
  switch (event.type) {
    case "connecting":
      return { ...state, status: "connecting" };
    case "backendReady":
      return {
        ...state,
        status: "connected",
        backendVersion: event.payload.version,
        offlineAuth: event.payload.offlineAuth,
      };
    case "disconnected":
      // `offlineAuth` deliberately survives: which ports this process was built
      // with does not change when a socket drops.
      return { ...state, status: "disconnected", backendVersion: "" };
  }
}
