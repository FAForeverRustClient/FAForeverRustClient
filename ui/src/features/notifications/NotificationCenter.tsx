import { useOverlayLayer } from "../../design-system/useOverlayLayer";
import { useCallback, useEffect, useRef, useState, lazy, Suspense, type ReactNode } from "react";
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
import { deliveryFor } from "./notificationDelivery";
import { TimedToast } from "./TimedToast";
import { NotificationRecovery } from "./NotificationRecovery";
import { NotificationArtwork, notificationArtwork } from "./notificationArtwork";
import { RepeatCooldown, expiredNotifications, happensInView, nextExpiry } from "./notificationGate";
import { notificationBody, notificationBodyDetail, notificationTitle } from "./notificationText";
import "./notifications.css";
import { t } from "../../i18n";
import { useLocale } from "../../i18n/useTranslation";

const NotificationGameDialog = lazy(() => import("./NotificationGameDialog"));

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
    case "watchLiveWhenReady": return t("notifications.action.watchLiveWhenReady");
    case "openStream": return t("notifications.action.openStream");
    case "focusGame": return t("notifications.action.focusGame");
    case "openGame": return t("notifications.action.openGame");
    case "openReview": return t("notifications.action.openReview");
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
 *
 * Drawn as the client's own button (`btn-ghost`), so it reads as something to
 * press (#653): a word in capitals under the text read as a caption. The
 * whole card is the button, so this is its look, not a second one inside it.
 */
function actionContent(action: NotificationAction | null): ReactNode {
  if (action?.type === "openStream" && isTwitchUrl(action.payload.url)) {
    return (
      <span className="btn-ghost notification-action notification-stream" aria-label={t("notifications.action.openStream")}>
        <Icon name="twitch" size={14} />
        Twitch
      </span>
    );
  }
  const label = actionLabel(action);
  return label ? <span className="btn-ghost notification-action">{label}</span> : null;
}

function isTwitchUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "twitch.tv" || host.endsWith(".twitch.tv");
  } catch {
    return false;
  }
}

async function runAction(item: ClientNotification, openGame: (id: number) => void) {
  const action = item.action;
  if (action) {
    switch (action.type) {
      case "openChat":
        await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "chat" } } });
        await ipc.settle({ kind: "Chat", command: { type: "joinChannel", payload: { channel: action.payload.channel } } });
        await ipc.settle({ kind: "Chat", command: { type: "selectChannel", payload: { channel: action.payload.channel } } });
        break;
      case "openGame":
        openGame(action.payload.gameId);
        break;
      case "openReview":
        await ipc.settle({ kind: "Reviews", command: { type: "open", payload: { target: action.payload.target } } });
        break;
      case "focusGame":
        await native.gameNotificationAttention(true);
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
      case "watchLiveWhenReady":
        // The live replay tab's own "watch when ready": the backend waits out
        // the delay and starts the replay itself (#653). Without leaving the
        // tab the player is on: there is nothing to do on the replay tab
        // while the delay runs, and the replay opens in its own window.
        await ipc.dispatch({
          kind: "Replays",
          command: { type: "trackLive", payload: { target: action.payload.target, action: "watch" } },
        });
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
  const [gamePreviewId, setGamePreviewId] = useState<number | null>(null);
  const [toastIds, setToastIds] = useState<string[]>([]);
  const processed = useRef(new Set<string>());
  const cooldown = useRef(new RepeatCooldown());
  const panelRef = useRef<HTMLDivElement>(null);
  const unread = items.filter((item) => !item.read).length;
  const toasts = toastIds
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is ClientNotification => !!item);
  const hideToast = useCallback((id: string) => {
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
    ipc.run(runAction(item, setGamePreviewId));
  }, [hideToast]);
  const clearAll = useCallback(() => {
    setToastIds([]);
    ipc.send({ kind: "Notifications", command: { type: "clear" } });
  }, []);

  useOverlayLayer(open, () => {
    setOpen(false);
    panelRef.current?.querySelector<HTMLButtonElement>(".notification-bell")?.focus();
  });

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (!preferences.enabled || !preferences.popup) setToastIds([]);
  }, [preferences.enabled, preferences.popup]);

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
    const announcing = fresh.filter((item) => Object.values(deliveryFor(item.kind, preferences)).some(Boolean));
    if (announcing.length === 0) return;
    void (async () => {
      const focused = await native.isWindowFocused().catch(() => document.hasFocus());
      let gameFocused = false;
      if (announcing.some((item) => item.kind === "gameFull")) {
        gameFocused = await native.gameNotificationAttention().catch(() => false);
      }
      if (!focused && !gameFocused) void native.requestAttention().catch(() => undefined);
      // The settings as they are now, not as they were when the batch arrived:
      // the checks above wait on the shell, and a switch turned off meanwhile
      // (sound muted, desktop off) must already hold for this batch.
      const currentState = useAppStore.getState().state;
      const latest = currentState.settings.notifications;
      const visible = announcing.filter((item) => !(item.kind === "gameFull" && gameFocused)
        && latest.enabled
        && currentState.notifications.items.some((n) => n.id === item.id && !n.read));
      // Sound admission is independent from popup delivery and focus.
      visible.forEach((item) => {
        if (deliveryFor(item.kind, latest).sound) {
          playNotificationSound(soundForKind(item.kind, latest.sounds), latest.volume);
        }
      });
      const desktop = visible.filter((item) => deliveryFor(item.kind, latest).desktop)
        .filter(() => !focused || latest.notifyWhenFocused);
      const popupStyle = (latest.desktopStyle ?? "popup") === "popup";
      const showInside = (candidates: ClientNotification[]) => {
        const current = useAppStore.getState().state;
        const inside = candidates.filter((item) => current.notifications.items.some((n) => n.id === item.id && !n.read)
          && deliveryFor(item.kind, current.settings.notifications).popup);
        if (inside.length) setToastIds((ids) => [...inside.map((item) => item.id), ...ids].slice(0, 3));
      };
      // What will not be offered to the desktop popup is shown now: the popup
      // can take up to three seconds to answer, and these do not depend on it.
      showInside(visible.filter((item) => !(popupStyle && desktop.includes(item))));
      let delivered = false;
      if (desktop.length && popupStyle) {
        delivered = await native.showNotificationPopup(desktop.map((item) => ({
          id: item.id, title: notificationTitle(item), body: stripHtmlTags(notificationBody(item)),
          actionLabel: actionLabel(item.action), tone: notificationTone(item).trim(), imageUrl: notificationArtwork(item, useAppStore.getState().state),
        })), t("notifications.popup.dismiss")).then(() => true, () => false);
      }
      if (desktop.length && !delivered) {
        const state = useAppStore.getState().state;
        const focusedNow = await native.isWindowFocused().catch(() => true);
        const fallback = desktop.filter((item) => deliveryFor(item.kind, state.settings.notifications).desktop
          && (!focusedNow || state.settings.notifications.notifyWhenFocused)
          && state.notifications.items.some((n) => n.id === item.id && !n.read));
        if (fallback.length && await native.ensureNotificationPermission().catch(() => false)) {
          fallback.forEach((item) => native.sendNotification(notificationTitle(item), stripHtmlTags(notificationBody(item))));
        }
      }
      // The popup could not show them: they get the in-client card after all.
      if (popupStyle && !delivered) showInside(desktop);
    })().catch(() => undefined);
  }, [items, preferences]);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void native.onNotificationInteraction(({ id, interaction }) => {
      const item = useAppStore.getState().state.notifications.items.find((candidate) => candidate.id === id);
      if (!item) return;
      hideToast(id);
      if (interaction === "dismiss") dismiss(id);
      // Native activation already focused the owned game. Avoid doing it twice.
      else if (item.action?.type === "focusGame") markRead(id);
      else ipc.run(runAction(item, setGamePreviewId));
    }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch(() => undefined);
    return () => { disposed = true; stop?.(); };
  }, [hideToast]);

  // A notification leaves the history by itself once it is older than the
  // player's chosen time (#644); zero keeps every one. One timer, for the
  // next one due, re-armed whenever the list changes or that one goes.
  const historyLifetime = preferences.historyLifetimeSeconds ?? 0;
  const [expiryCheck, setExpiryCheck] = useState(0);
  useEffect(() => {
    if (historyLifetime <= 0) return;
    const expired = expiredNotifications(items, historyLifetime, Date.now());
    expired.forEach((item) => {
      hideToast(item.id);
      dismiss(item.id);
    });
    const remaining = expired.length === 0 ? items : items.filter((item) => !expired.includes(item));
    const due = nextExpiry(remaining, historyLifetime);
    if (due === null) return;
    const timer = window.setTimeout(() => setExpiryCheck((check) => check + 1), Math.max(0, due - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [items, historyLifetime, expiryCheck, hideToast]);

  return (
    <div className="notification-center" ref={panelRef}>
      {gamePreviewId !== null && <Suspense fallback={null}><NotificationGameDialog id={gamePreviewId} onClose={() => setGamePreviewId(null)} /></Suspense>}
      <button
        type="button"
        className="notification-bell"
        aria-label={unread ? t("notifications.unread", { count: unread }) : t("notifications.title")}
        aria-expanded={open}
        title={t("notifications.title")}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="bell" size={16} />
        {unread > 0 && <span className={`notification-badge${items.some((item) => !item.read && item.kind === "error") ? " is-error" : items.some((item) => !item.read && ["serverWarning", "gameCacheAlert"].includes(item.kind)) ? " is-warning" : ""}`}>{unread > 99 ? "99+" : unread}</span>}
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
                  <span className="notification-item-head"><span className="notification-title"><NotificationArtwork url={notificationArtwork(item, useAppStore.getState().state)} /><strong>{notificationTitle(item)}</strong></span><time dateTime={item.createdAt}>{formatTime(item.createdAt, "", use24HourTime)}</time></span>
                  <span className="notification-body" title={notificationBodyDetail(item) ?? undefined}>{renderFormattedText(notificationBody(item))}</span>
                  {actionContent(item.action)}
                </button>
                <button className="notification-dismiss" type="button" onClick={() => { hideToast(item.id); dismiss(item.id); }} aria-label={t("notifications.dismiss", { title: notificationTitle(item) })}>
                  <Icon name="close" size={12} />
                </button>
                {item.kind === "error" && <NotificationRecovery item={item} />}
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
          <TimedToast className={notificationTone(item)} key={item.id} duration={(preferences.toastDurationSeconds ?? 5) * 1000} onExpire={() => autoDismiss(item.id)}>
            <button type="button" onClick={() => handleAction(item)}>
              <span className="notification-title"><NotificationArtwork url={notificationArtwork(item, useAppStore.getState().state)} /><strong>{notificationTitle(item)}</strong></span>
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
          </TimedToast>
        ))}
      </div>
    </div>
  );
}
