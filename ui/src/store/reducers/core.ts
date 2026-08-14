import type {
  AuthEvent,
  AuthState,
  InstallEvent,
  InstallState,
  NavEvent,
  NavState,
  PlayerNote,
  SessionEvent,
  SessionState,
  SettingsEvent,
  SettingsState,
  SocialPreferences,
} from "../../ipc/bindings";
import { normalizeBrowsingPreferences } from "../../shared/browsingPreferences";

const PLAYER_NOTE_CHARACTER_LIMIT = 150;
const PLAYER_NOTE_LIMIT = 1000;
const PLAYER_NOTE_LOGIN_LIMIT = 64;

// Twin of SocialPreferences::normalized in crates/faf-domain/src/state/settings.rs.
// Rust collects into a BTreeMap keyed by player id, so a later entry replaces an
// earlier one with the same id and the result comes out ordered by id. Character
// counts use code points, not UTF-16 units, to match Rust's `chars()`.
function normalizeSocialPreferences(preferences: SocialPreferences): SocialPreferences {
  const notes = new Map<number, PlayerNote>();
  for (const entry of preferences.playerNotes) {
    if (entry.playerId <= 0) continue;
    const login = entry.login.trim();
    const note = [...entry.note.trim()].slice(0, PLAYER_NOTE_CHARACTER_LIMIT).join("");
    if (login === "" || [...login].length > PLAYER_NOTE_LOGIN_LIMIT || note === "") continue;
    notes.set(entry.playerId, { playerId: entry.playerId, login, note });
  }
  const playerNotes = [...notes.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => entry)
    .slice(0, PLAYER_NOTE_LIMIT);
  return { ...preferences, playerNotes };
}

export function reduceSettings(
  state: SettingsState,
  event: SettingsEvent,
): SettingsState {
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
      return { ...state, social: normalizeSocialPreferences(event.payload.preferences) };
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
    default: {
      const unhandled: never = event;
      void unhandled;
      return state;
    }
  }
}

export function reduceNav(
  state: NavState,
  event: NavEvent,
): NavState {
  switch (event.type) {
    case "tabSelected":
      return { ...state, activeTab: event.payload.tab };
    default: {
      const unhandled: never = event.type;
      void unhandled;
      return state;
    }
  }
}

export function reduceAuth(
  state: AuthState,
  event: AuthEvent,
): AuthState {
  switch (event.type) {
    case "loginStarted":
      return { ...state, status: "loggingIn", error: null };
    case "loggedIn":
      return {
        ...state,
        status: "loggedIn",
        player: event.payload.player,
        error: null,
        mode: "account",
      };
    case "testLoggedIn":
      return {
        ...state,
        status: "loggedIn",
        player: event.payload.player,
        error: null,
        mode: "test",
      };
    case "loginFailed":
      return {
        ...state,
        status: "failed",
        player: null,
        error: event.payload.message,
      };
    case "loggedOut":
      return {
        ...state,
        status: "loggedOut",
        player: null,
        error: null,
        mode: "account",
      };
    default: {
      const unhandled: never = event;
      void unhandled;
      return state;
    }
  }
}

export function reduceSession(
  state: SessionState,
  event: SessionEvent,
): SessionState {
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
      // offlineAuth is deliberately retained: which ports this process was
      // built with does not change when the socket drops (session.rs:75).
      return {
        ...state,
        status: "disconnected",
        backendVersion: "",
      };
    default: {
      const unhandled: never = event;
      void unhandled;
      return state;
    }
  }
}

export function reduceInstall(
  state: InstallState,
  event: InstallEvent,
): InstallState {
  switch (event.type) {
    case "checked":
      return {
        ...state,
        gameReady: event.payload.gameReady,
        replayReady: event.payload.replayReady,
        checked: true,
      };
    default: {
      const unhandled: never = event.type;
      void unhandled;
      return state;
    }
  }
}