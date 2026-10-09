import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../../design-system/Icon";
import type { ClientNotification, NotificationAction } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { requestSettingsSection } from "../settings/settingsNavigation";
import { native } from "../../ipc/native";
import { openHttpsUrl } from "../../shared/externalLinks";
import { useClockPreference } from "../../shared/format/clock";
import { formatTime } from "../../shared/format/dates";
import { useAppStore } from "../../store/store";
import { renderFormattedText, stripHtmlTags } from "../chat/messages/chatFormat";
import { playNotificationSound, soundForKind } from "./notificationSound";
import { raisesOsNotification } from "./osNotifications";
import { RepeatCooldown, happensInView } from "./notificationGate";
import { notificationBody, notificationBodyDetail, notificationTitle } from "./notificationText";
import "./notifications.css";
import { t } from "../../i18n";
import { useLocale } from "../../i18n/useTranslation";

/**
 * How long a toast stays on screen (#455): long enough to read, short enough
 * that a "player in range" alert is not still in the corner a minute later.
 * The notification itself stays in the centre under the bell.
 */
const TOAST_DURATION_MS = 5_000;

const markRead = (id: string) =>
  ipc.send({ kind: "Notifications", command: { type: "markRead", payload: { id } } });
const dismiss = (id: string) =>
  ipc.send({ kind: "Notifications", command: { type: "dismiss", payload: { id } } });

/**
 * The line under the message saying what a click will do, where that is worth
 * a line.
 *
 * The whole card is one button, so every notification already does its action
 * when clicked anywhere: "meanwhile i dont even have to click open chat to
 * open chat, i can just click it anywhere". A label that only repeats the
 * card's own title therefore says nothing, and it said it loudly, in bold
 * uppercase over a greyed-out message. Somebody read "OPEN CHAT" as the
 * message they had been sent.
 *
 * So the label is kept only where the click is not simply "show me this":
 * accepting a party invite acts on somebody else's invitation, watching a
 * live game starts a replay, and a stream leaves the client for a browser.
 * Opening a tab in the client speaks for itself.
 */
function actionLabel(action: NotificationAction | null): string | null {
  if (!action) return null;
  switch (action.type) {
    case "acceptPartyInvite": return t("notifications.action.acceptPartyInvite");
    case "watchLive": return t("notifications.action.watchLive");
    case "openStream": return t("notifications.action.openStream");
    case "openChat":
    case "openMatchmaking":
    case "openCustomGames":
    case "openSettings":
    case "openEvent":
      return null;
  }
}

/**
 * The action line of a card: the label above, or for a stream the platform it
 * opens as an icon and its name (#155), which says where the click goes more
 * plainly than "Watch the stream" did.
 */
function actionContent(action: NotificationAction | null): ReactNode {
  if (action?.type === "openStream" && isTwitchUrl(action.payload.url)) {
    return (
      <em className="notification-stream" aria-label={t("notifications.action.openStream")}>
        <Icon name="twitch" size={14} />
        Twitch
      </em>
    );
  }
  const label = actionLabel(action);
  return label ? <em>{label}</em> : null;
}

function isTwitchUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "twitch.tv" || host.endsWith(".twitch.tv");
  } catch {
    return false;
  }
}

async function runAction(item: ClientNotification) {
  const action = item.action;
  if (action) {
    switch (action.type) {
      case "openChat":
        await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "chat" } } });
        await ipc.settle({ kind: "Chat", command: { type: "joinChannel", payload: { channel: action.payload.channel } } });
        await ipc.settle({ kind: "Chat", command: { type: "selectChannel", payload: { channel: action.payload.channel } } });
        break;
      case "openMatchmaking":
        await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "play" } } });
        await ipc.settle({ kind: "Lobby", command: { type: "setPlayMode", payload: { mode: "matchmaking" } } });
        break;
      case "openCustomGames":
        await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "play" } } });
        await ipc.settle({ kind: "Lobby", command: { type: "setPlayMode", payload: { mode: "custom" } } });
        break;
      case "acceptPartyInvite":
        await ipc.settle({ kind: "Lobby", command: { type: "acceptPartyInvite", payload: { playerId: action.payload.playerId } } });
        await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "play" } } });
        await ipc.settle({ kind: "Lobby", command: { type: "setPlayMode", payload: { mode: "matchmaking" } } });
        break;
      case "watchLive":
        await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "replays" } } });
        await ipc.dispatch({ kind: "Replays", command: { type: "watchLive", payload: action.payload.target } });
        break;
      case "openEvent":
        // The calendar opens on the occurrence the reminder was set for, which
        // may be weeks from the month the tab was left on: the anchor moves
        // with the selection rather than the reader having to find it.
        await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "events" } } });
        await ipc.settle({
          kind: "Events",
          command: { type: "select", payload: { occurrenceId: action.payload.occurrenceId } },
        });
        break;
      case "openStream":
        // Out to the browser rather than into a frame: this client is not a
        // video player, and `openHttpsUrl` validates the address the backend
        // handed it the same way it validates every other one.
        await openHttpsUrl(action.payload.url);
        break;
      case "openSettings":
        await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "settings" } } });
        if (action.payload.section) {
          // The payload carries a section *key* (`gameCache`, `updates`), which
          // now names a register rather than an element to scroll to: the
          // register the notification means is not on screen at all until the
          // rail opens it, so scrolling could never have reached it.
          requestSettingsSection(action.payload.section);
        }
        break;
    }
  }
  markRead(item.id);
}

function notificationTone(item: ClientNotification): string {
  if (item.kind === "error") return " is-error";
  if (item.kind === "serverWarning" || item.kind === "gameCacheAlert") return " is-warning";
  if (item.kind === "serverNotice") return " is-server";
  return "";
}

export function NotificationCenter() {
  useLocale();
  const items = useAppStore((state) => state.state.notifications.items);
  const preferences = useAppStore((state) => state.state.settings.notifications);
  // The centre is always mounted, so it subscribes to the clock preference
  // rather than reading it once: flipping the switch redraws the cards (#425).
  const use24HourTime = useClockPreference();
  const [open, setOpen] = useState(false);
  const [toastIds, setToastIds] = useState<string[]>([]);
  const processed = useRef(new Set<string>());
  const cooldown = useRef(new RepeatCooldown());
  const timers = useRef(new Map<string, number>());
  const panelRef = useRef<HTMLDivElement>(null);
  const unread = items.filter((item) => !item.read).length;
  const toasts = toastIds
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is ClientNotification => !!item);
  const hideToast = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setToastIds((current) => current.filter((candidate) => candidate !== id));
  }, []);
  const autoDismiss = useCallback((id: string) => {
    // The toast goes either way: one that waited for the window to be focused
    // stayed in the corner indefinitely, for as long as the client sat behind
    // something else, and could only be clicked away (#455). What waits for
    // the window is marking it read. A toast that expired in the background
    // may not have been seen, so it stays unread and the bell still counts it.
    hideToast(id);
    if (document.hasFocus()) markRead(id);
  }, [hideToast]);
  const handleAction = useCallback((item: ClientNotification) => {
    hideToast(item.id);
    ipc.run(runAction(item));
  }, [hideToast]);
  const clearAll = useCallback(() => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
    setToastIds([]);
    ipc.send({ kind: "Notifications", command: { type: "clear" } });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    const unreadIds = new Set(items.filter((item) => !item.read).map((item) => item.id));
    setToastIds((current) => {
      const next = current.filter((id) => unreadIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [items]);

  useEffect(() => {
    const currentIds = new Set(items.map((item) => item.id));
    processed.current = new Set(
      [...processed.current].filter((id) => currentIds.has(id)),
    );
    const arrived = items.filter((item) => !item.read && !processed.current.has(item.id));
    if (arrived.length === 0) return;
    arrived.forEach((item) => processed.current.add(item.id));
    if (!preferences.enabled) return;
    // A message in the conversation already on screen is read as it arrives,
    // so it goes straight into the history as read and is not announced.
    const { nav, chat } = useAppStore.getState().state;
    const focused = document.hasFocus();
    const now = Date.now();
    const fresh = arrived.filter((item) => {
      if (happensInView(item, nav.activeTab, chat.activeChannel, focused)) {
        markRead(item.id);
        return false;
      }
      // Another of the same kind too soon after the last one (#382): kept in
      // the history, unread, but not announced a second time.
      return cooldown.current.admit(item.kind, now, preferences.repeatCooldownSeconds ?? 0);
    });
    if (fresh.length === 0) return;
    setToastIds((current) => [...fresh.map((item) => item.id), ...current].slice(0, 3));

    fresh.forEach((item) => {
      // Per kind now, not one tone for everything with a louder variant for two
      // of them: which tone a kind plays is the player's choice, and "silent"
      // is one of the choices, so a kind can be seen and not heard.
      if (preferences.sound) {
        playNotificationSound(soundForKind(item.kind, preferences.sounds), preferences.volume);
      }
    });
    if (preferences.desktop) {
      // Not the whole batch. The client used to hand every notification it
      // raised to the operating system as well, so a friend coming online
      // interrupted whatever the user was doing; `raisesOsNotification` is the
      // short list of kinds somebody is waiting on. The switch below restores
      // the old behaviour for anyone who wants it.
      const leaving = preferences.desktopAllKinds
        ? fresh
        : fresh.filter((item) => raisesOsNotification(item.kind));
      if (leaving.length === 0) return;
      // Check focus and request permission once per batch. Parallel permission
      // prompts from several notifications are rejected on some platforms.
      void (async () => {
        const focused = await native.isWindowFocused().catch(() => true);
        if (focused && !preferences.notifyWhenFocused) return;
        if (!await native.ensureNotificationPermission()) return;
        leaving.forEach((item) => native.sendNotification(notificationTitle(item), stripHtmlTags(notificationBody(item))));
      })().catch(() => undefined);
    }
  }, [items, preferences]);

  useEffect(() => {
    const activeIds = new Set(toastIds);
    timers.current.forEach((timer, id) => {
      if (!activeIds.has(id)) {
        window.clearTimeout(timer);
        timers.current.delete(id);
      }
    });
    toastIds.forEach((id) => {
      if (timers.current.has(id)) return;
      timers.current.set(id, window.setTimeout(() => autoDismiss(id), TOAST_DURATION_MS));
    });
  }, [autoDismiss, toastIds]);

  useEffect(() => () => {
    timers.current.forEach((timer) => window.clearTimeout(timer));
    timers.current.clear();
  }, []);

  return (
    <div className="notification-center" ref={panelRef}>
      <button
        type="button"
        className="notification-bell"
        aria-label={unread ? t("notifications.unread", { count: unread }) : t("notifications.title")}
        aria-expanded={open}
        title={t("notifications.title")}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="bell" size={16} />
        {unread > 0 && <span className="notification-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>

      {open && (
        <section className="notification-panel" aria-label={t("notifications.title")}>
          <header>
            <strong>{t("notifications.title")}</strong>
            {items.length > 0 && (
              <button type="button" onClick={clearAll}>
                {t("notifications.clearAll")}
              </button>
            )}
          </header>
          <div className="notification-list">
            {items.length === 0 ? (
              <p className="notification-empty muted">{t("notifications.empty")}</p>
            ) : items.map((item) => (
              <article className={`notification-item${item.read ? " is-read" : ""}${notificationTone(item)}`} key={item.id}>
                <button className="notification-content" type="button" onClick={() => handleAction(item)}>
                  <span className="notification-item-head"><strong>{notificationTitle(item)}</strong><time dateTime={item.createdAt}>{formatTime(item.createdAt, "", use24HourTime)}</time></span>
                  <span className="notification-body" title={notificationBodyDetail(item) ?? undefined}>{renderFormattedText(notificationBody(item))}</span>
                  {actionContent(item.action)}
                </button>
                <button className="notification-dismiss" type="button" onClick={() => { hideToast(item.id); dismiss(item.id); }} aria-label={t("notifications.dismiss", { title: notificationTitle(item) })}>
                  <Icon name="close" size={12} />
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* The corner is a preference, and its default is the corner the bell is
          in. Toasts used to arrive top right while the centre they are kept in
          opens from the bottom left, so a toast that slid away left nothing
          where the eye had just learned to look. */}
      <div
        className={`notification-toasts is-${preferences.toastPosition}`}
        aria-live="polite"
        aria-atomic="false"
      >
        {toasts.map((item) => (
          <article className={`notification-toast${notificationTone(item)}`} key={item.id}>
            <button type="button" onClick={() => handleAction(item)}>
              <strong>{notificationTitle(item)}</strong>
              {/* A failure reason is worded plainly; the original is on hover,
                  here and in the centre (see `notificationText`). */}
              <span className="notification-body" title={notificationBodyDetail(item) ?? undefined}>{renderFormattedText(notificationBody(item))}</span>
              {actionContent(item.action)}
            </button>
            <button
              type="button"
              className="notification-dismiss"
              onClick={() => {
                hideToast(item.id);
                dismiss(item.id);
              }}
              aria-label={t("notifications.dismiss", { title: notificationTitle(item) })}
            >
              <Icon name="close" size={12} />
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
