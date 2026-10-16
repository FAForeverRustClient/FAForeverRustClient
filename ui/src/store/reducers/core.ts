import type {
  AppearancePreferences,
  AuthEvent,
  AuthState,
  EventReminder,
  InstallEvent,
  InstallState,
  NavEvent,
  NavState,
  SessionEvent,
  SessionState,
  SettingsEvent,
  SettingsState,
} from "../../ipc/bindings";
import { normalizePlayerNotes } from "../../shared/rules/playerNotes";
import { normalizeReplayNotes } from "../../shared/rules/replayNotes";
import { normalizeBrowsingPreferences } from "../../shared/browsingPreferences";
import {
  normalizePathPreferences,
  withKeptGeneratedMaps,
} from "../../shared/pathPreferences";

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
    case "pathsChanged":
      return { ...state, paths: normalizePathPreferences(event.payload.preferences) };
    case "keptGeneratedMaps":
      return {
        ...state,
        keptGeneratedMaps: withKeptGeneratedMaps(
          state.keptGeneratedMaps ?? [],
          event.payload.mapNames,
        ),
      };
    case "generalChanged":
      return { ...state, general: event.payload.preferences };
    case "appearanceChanged":
      return { ...state, appearance: normalizeAppearance(event.payload.preferences) };
    case "socialChanged":
      return {
        ...state,
        social: {
          ...event.payload.preferences,
          playerNotes: normalizePlayerNotes(event.payload.preferences.playerNotes),
          replayNotes: normalizeReplayNotes(event.payload.preferences.replayNotes),
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
    case "debugChanged":
      return { ...state, debug: event.payload.preferences };
    case "updatesChanged":
      return { ...state, updates: event.payload.preferences };
    case "browsingChanged":
      return { ...state, browsing: normalizeBrowsingPreferences(event.payload.preferences) };
    case "mapGeneratorChanged":
      return { ...state, mapGenerator: event.payload.preferences };
    case "eventsChanged":
      return {
        ...state,
        events: {
          ...event.payload.preferences,
          reminders: dedupedReminders(event.payload.preferences.reminders),
        },
      };
    case "cacheInfoUpdated":
      return { ...state, cacheInfo: event.payload.info };
    // One whole selection, replaced rather than merged: clearing every veto
    // has to be able to clear it.
    case "matchmakerVetoesChanged":
      return { ...state, matchmakerVetoes: event.payload.vetoes };
    case "mapPoolsSeen":
      return { ...state, mapPoolsSeen: event.payload.seen };
    // Replaced whole as well: the service orders and caps the list.
    case "avatarHistoryChanged":
      return { ...state, avatarHistory: event.payload.history };
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Twin of `AppearancePreferences::normalized`, with its bounds
 * (`MIN_UI_SCALE`/`MAX_UI_SCALE`, `MIN_SIDEBAR_WIDTH`/`MAX_SIDEBAR_WIDTH`,
 * `MAX_HOVER_DELAY_MS`).
 *
 * The Rust reducer clamps on the way into state, and this one stored whatever
 * arrived: a scale of 400 was applied as a 400% zoom here while the backend
 * held 200.
 */
function normalizeAppearance(preferences: AppearancePreferences): AppearancePreferences {
  return {
    ...preferences,
    uiScale: clamp(preferences.uiScale, 80, 200),
    gameTileColumns: Math.min(preferences.gameTileColumns, 6),
    sidebarWidth: clamp(preferences.sidebarWidth, 64, 400),
    hoverOpenDelayMs: Math.min(preferences.hoverOpenDelayMs, 2000),
    hoverCloseDelayMs: Math.min(preferences.hoverCloseDelayMs, 2000),
    backgroundDim: Math.min(preferences.backgroundDim, 90),
  };
}

/**
 * Twin of `EventsPreferences::pruned`, for the half of it that is not the clock.
 *
 * The Rust side prunes by time at the persistence boundary, where the clock is,
 * and deduplicates in the reducer, where a hand-edited settings file with the
 * same occurrence twice would otherwise be raised twice. The first copy wins.
 */
function dedupedReminders(reminders: EventReminder[]): EventReminder[] {
  const seen = new Set<string>();
  return reminders.filter((reminder) => {
    if (seen.has(reminder.occurrenceId)) return false;
    seen.add(reminder.occurrenceId);
    return true;
  });
}

export function reduceNav(state: NavState, event: NavEvent): NavState {
  switch (event.type) {
    case "tabSelected":
      return { ...state, activeTab: event.payload.tab };
    case "mapsSectionSelected":
      return { ...state, mapsSection: event.payload.section };
    case "modsSectionSelected":
      return { ...state, modsSection: event.payload.section };
    case "replaysSectionSelected":
      return { ...state, replaysSection: event.payload.section };
    case "settingsSectionSelected":
      return { ...state, settingsSection: event.payload.section };
    case "changelogSectionSelected":
      return { ...state, changelogSection: event.payload.section };
    // Choosing a client release opens the client section too, or it would not
    // be on screen.
    case "changelogClientReleaseSelected":
      return {
        ...state,
        changelogSection: "client",
        changelogClientVersion: event.payload.version,
      };
  }
}

export function reduceInstall(_state: InstallState, event: InstallEvent): InstallState {
  switch (event.type) {
    case "checked":
      return {
        gameReady: event.payload.gameReady,
        replayReady: event.payload.replayReady,
        gamePending: event.payload.gamePending,
        replayPending: event.payload.replayPending,
        resolved: event.payload.resolved,
        checked: true,
      };
  }
}

export function reduceAuth(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case "loginStarted":
      return { ...state, status: "loggingIn", error: null, signInLink: null };
    case "signInLinkReady":
      // Only for the attempt in progress; a late one after it ended is ignored.
      return state.status === "loggingIn" ? { ...state, signInLink: event.payload.url } : state;
    case "loggedIn":
      return { ...state, status: "loggedIn", player: event.payload.player, error: null, mode: "account", signInLink: null };
    case "testLoggedIn":
      return { ...state, status: "loggedIn", player: event.payload.player, error: null, mode: "test", signInLink: null };
    case "wentOffline":
      return { ...state, status: "loggedIn", player: null, error: null, mode: "offline", signInLink: null };
    case "banned":
      // The lobby refused a banned account (#488): what is left is an offline
      // session, with the server's reason kept.
      return { ...state, status: "loggedIn", player: null, error: event.payload.message, mode: "offline", signInLink: null };
    case "loginFailed":
      return { ...state, status: "failed", player: null, error: event.payload.message, signInLink: null };
    case "loggedOut":
      return { ...state, status: "loggedOut", player: null, error: null, mode: "account", signInLink: null };
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
