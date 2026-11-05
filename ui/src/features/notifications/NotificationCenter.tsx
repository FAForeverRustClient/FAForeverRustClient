import { useOverlayLayer } from "../../design-system/useOverlayLayer";
import { useCallback, useEffect, useRef, useState, lazy, Suspense } from "react";
import { Icon } from "../../design-system/Icon";
import type { ClientNotification } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { requestSettingsSection } from "../settings/settingsNavigation";
import { native } from "../../ipc/native";
import { openHttpsUrl } from "../../shared/externalLinks";
import { useClockPreference } from "../../shared/format/clock";
import { useAppStore } from "../../store/store";
import { NotificationCard } from "./NotificationCard";
import { admitNotifications, deliverNotifications } from "./deliverNotifications";
import { NotificationRecovery } from "./NotificationRecovery";
import { notificationArtwork } from "./notificationArtwork";
import { deliveryFor } from "./notificationDelivery";
import { RepeatCooldown, expiredNotifications, nextExpiry } from "./notificationGate";
import "./notifications.css";
import { t } from "../../i18n";
import { useLocale } from "../../i18n/useTranslation";

const NotificationGameDialog = lazy(() => import("./NotificationGameDialog"));

const markRead = (id: string) =>
  ipc.send({ kind: "Notifications", command: { type: "markRead", payload: { id } } });
const dismiss = (id: string) =>
  ipc.send({ kind: "Notifications", command: { type: "dismiss", payload: { id } } });

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
      case "updateClient":
        // Download, then install, from the one click (#682). A download the
        // background already finished installs at once. Install closes the
        // client, so it refuses itself while a game, search or lesson runs,
        // and the sidebar's update notice offers it again afterwards.
        if (useAppStore.getState().state.clientUpdate.status.type !== "ready") {
          await ipc.settle({ kind: "ClientUpdate", command: { type: "download" } });
        }
        if (useAppStore.getState().state.clientUpdate.status.type === "ready") {
          await ipc.settle({ kind: "ClientUpdate", command: { type: "install" } });
        }
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

export function NotificationCenter() {
  useLocale();
  const items = useAppStore((state) => state.state.notifications.items);
  const preferences = useAppStore((state) => state.state.settings.notifications);
  // The centre is always mounted, so it subscribes to the clock preference
  // rather than reading it once: flipping the switch redraws the cards (#425).
  const use24HourTime = useClockPreference();
  const [open, setOpen] = useState(false);
  // What was unread when the bell was opened. Opening it marks everything
  // read, so the count goes, but these keep their dot while the panel is
  // open: the reader still sees which entries are the new ones.
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const [gamePreviewId, setGamePreviewId] = useState<number | null>(null);
  const [toastIds, setToastIds] = useState<string[]>([]);
  const processed = useRef(new Set<string>());
  const cooldown = useRef(new RepeatCooldown());
  const panelRef = useRef<HTMLDivElement>(null);
  const unread = items.filter((item) => !item.read).length;
  const toasts = toastIds
    .map((id) => items.find((item) => item.id === id))
    .filter((item): item is ClientNotification => !!item)
    .slice(0, 3);
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
  const toggleOpen = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const unreadIds = items.filter((item) => !item.read).map((item) => item.id);
    setFresh(new Set(unreadIds));
    unreadIds.forEach(markRead);
    setOpen(true);
  };
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
    const unreadIds = new Set(items.filter((item) => !item.read && deliveryFor(item.kind, preferences).popup).map((item) => item.id));
    setToastIds((current) => {
      const next = current.filter((id) => unreadIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [items, preferences]);

  useEffect(() => {
    const currentIds = new Set(items.map((item) => item.id));
    processed.current = new Set(
      [...processed.current].filter((id) => currentIds.has(id)),
    );
    const arrived = items.filter((item) => !item.read && !processed.current.has(item.id));
    if (arrived.length === 0) return;
    arrived.forEach((item) => processed.current.add(item.id));
    const announcing = admitNotifications(arrived, useAppStore.getState().state, cooldown.current, markRead);
    void deliverNotifications(announcing, {
      state: () => useAppStore.getState().state,
      showInside: (inside) => setToastIds((ids) => {
        const immediate = inside.filter((item) => item.kind === "matchFound" || item.kind === "gameFull" || item.kind === "partyInvite").map((item) => item.id);
        return [...new Set([...immediate, ...ids, ...inside.map((item) => item.id)])];
      }),
    }).catch(() => undefined);
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
        onClick={toggleOpen}
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
              <NotificationCard key={item.id} item={fresh.has(item.id) ? { ...item, read: false } : item} artwork={notificationArtwork(item, useAppStore.getState().state)}
                history use24HourTime={use24HourTime} onActivate={() => handleAction(item)}
                onDismiss={() => { hideToast(item.id); dismiss(item.id); }}
                recovery={item.kind === "error" ? <NotificationRecovery item={item} /> : undefined} />
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
          <NotificationCard key={item.id} item={item} artwork={notificationArtwork(item, useAppStore.getState().state)}
            duration={(preferences.toastDurationSeconds ?? 5) * 1000} onActivate={() => handleAction(item)}
            onDismiss={() => { hideToast(item.id); dismiss(item.id); }} onExpire={() => autoDismiss(item.id)} />
        ))}
      </div>
    </div>
  );
}
