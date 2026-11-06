import type { ClientNotification, NotificationAction, NotificationKind, NotificationPreferences } from "../../ipc/bindings";
import { t, type MessageKey } from "../../i18n";

type BooleanPreference = { [K in keyof NotificationPreferences]: NotificationPreferences[K] extends boolean ? K : never }[keyof NotificationPreferences];
type Sample = { title: MessageKey; body?: MessageKey; enabled?: BooleanPreference; action?: NotificationAction; image?: "avatar" | "map" };
const chat: NotificationAction = { type: "openChat", payload: { channel: "notification-test" } };
const game: NotificationAction = { type: "openGame", payload: { gameId: 0 } };
const settings: NotificationAction = { type: "openSettings", payload: { section: "notifications" } };
// Actions are presentation examples only. Neither the gallery nor native preview IDs execute them.
export const NOTIFICATION_SAMPLES = {
  matchFound: { title: "notifications.msg.matchFound.title", body: "notifications.msg.matchFound.body", enabled: "matchFound", action: { type: "openMatchmaking" } },
  privateMessage: { title: "notifications.msg.privateMessage.title", enabled: "privateMessages", action: chat, image: "avatar" },
  mention: { title: "notifications.msg.mention.title", enabled: "mentions", action: chat, image: "avatar" },
  friendOnline: { title: "notifications.msg.friendOnline.title", body: "notifications.msg.friendOnline.body", enabled: "friendOnline", action: chat, image: "avatar" },
  friendOffline: { title: "notifications.msg.friendOffline.title", body: "notifications.msg.friendOffline.body", enabled: "friendOffline", image: "avatar" },
  friendPlaying: { title: "notifications.msg.friendPlaying.title", body: "notifications.msg.friendPlaying.body", enabled: "friendPlaying", action: { type: "watchLiveWhenReady", payload: { target: { uid: 0, modName: "faf", map: "notification-test" } } }, image: "map" },
  friendJoinedGame: { title: "notifications.msg.friendJoinedGame.title", body: "notifications.msg.friendJoinedGame.body", enabled: "friendJoinedGame", action: game, image: "map" },
  newCustomGame: { title: "notifications.msg.newCustomGame.title", body: "notifications.msg.newCustomGame.body", enabled: "newCustomGames", action: game, image: "map" },
  gameFull: { title: "notifications.msg.gameFull.title", body: "notifications.msg.gameFull.body", enabled: "gameFull", action: { type: "focusGame" }, image: "map" },
  gameLaunched: { title: "notifications.msg.gameLaunched.title", body: "notifications.msg.gameLaunched.body", enabled: "gameLaunched" },
  reviewReminder: { title: "notifications.msg.reviewReminder.title", body: "notifications.msg.reviewReminder.body", enabled: "reviewReminder", action: { type: "openReview", payload: { target: { kind: "game", id: 0, name: "" } } }, image: "map" },
  eventReminder: { title: "notifications.test.eventReminder", action: { type: "openEvent", payload: { occurrenceId: "notification-test" } } },
  // The friend's form of the event: a replay the player asked to be told about
  // reads "Live replay ready" instead, with the same button.
  replayAvailable: { title: "notifications.msg.friendReplayReady.title", body: "notifications.msg.friendReplayReady.body", action: { type: "watchLive", payload: { target: { uid: 0, modName: "faf", map: "notification-test" } } }, image: "map" },
  partyInvite: { title: "notifications.msg.partyInvite.title", body: "notifications.msg.partyInvite.body", enabled: "partyInvites", action: { type: "acceptPartyInvite", payload: { playerId: 0 } }, image: "avatar" },
  reportSubmitted: { title: "notifications.msg.reportSubmitted.title", body: "notifications.msg.reportSubmitted.body" },
  serverNotice: { title: "notifications.msg.serverInfo.title" },
  serverWarning: { title: "notifications.msg.serverWarning.title" },
  mapGenerated: { title: "notifications.msg.mapReady.title", enabled: "mapGenerated", image: "map" },
  gameCacheAlert: { title: "notifications.msg.gameCacheAlert.title", action: settings },
  gameInstall: { title: "notifications.msg.linuxRuntimeMissing.title", action: settings },
  clientUpdate: { title: "notifications.msg.clientUpdate.title", body: "notifications.msg.clientUpdate.body", action: { type: "updateClient" } },
  streamLive: { title: "settings.notifications.streamLive", enabled: "streamLive", action: { type: "openStream", payload: { url: "https://www.twitch.tv/faflive" } } },
  queueOpponent: { title: "notifications.msg.queueOpponent.title", body: "notifications.msg.queueOpponent.body", action: { type: "openMatchmaking" } },
  mapPoolReleased: { title: "notifications.msg.newMapPool.title", body: "notifications.msg.newMapPool.body", action: { type: "openMatchmaking" } },
  uploadFinished: { title: "notifications.msg.mapPublished.title", body: "notifications.msg.mapPublished.body" },
  avatarRestored: { title: "notifications.msg.avatarRestored.title", body: "notifications.msg.avatarRestored.body", image: "avatar" },
  error: { title: "notifications.msg.replayFailed.title" },
} satisfies Record<NotificationKind, Sample>;

export type TestScenario = "normal" | "burst" | "long" | "missingArt" | "repeat";
export function sampleNotification(kind: NotificationKind, id: string, scenario: TestScenario = "normal"): { item: ClientNotification; artwork: string | null } {
  const sample: Sample = NOTIFICATION_SAMPLES[kind];
  const player = t("notifications.test.player");
  const params = { login: player, host: player, sender: player, first: player, players: player,
    title: t("notifications.test.game"), game: t("notifications.test.game"), name: t("notifications.test.game"), queue: "1v1", count: 1, teamSize: 1, version: "0.0.0" };
  const body = sample.body ? t(sample.body, params) : t("notifications.test.message");
  return { item: { id, kind, title: `[${t("notifications.test.badge")}] ${t(sample.title, params)}`,
    body: scenario === "long" ? Array.from({ length: 6 }, () => body).join(" ") : body,
    createdAt: new Date().toISOString(), read: false, action: sample.action ?? null, text: null },
  artwork: scenario === "missingArt" ? "/assets/notification-test-missing.png"
    : sample.image === "map" ? "/assets/mapgen-placeholder.png" : sample.image === "avatar" ? "/assets/faflogo.svg" : null };
}

export function sampleEventEnabled(kind: NotificationKind, preferences: NotificationPreferences): boolean {
  const sample: Sample = NOTIFICATION_SAMPLES[kind];
  if (sample.enabled) return preferences[sample.enabled];
  if (kind === "queueOpponent") return preferences.queueOpponentQueues.length > 0;
  return true;
}
