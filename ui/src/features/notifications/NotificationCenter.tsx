import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../../design-system/Icon";
import type { ClientNotification, NotificationAction } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { useAppStore } from "../../store/store";
import { renderFormattedText, stripHtmlTags } from "../chat/chatFormat";
import { playNotificationAlert } from "./notificationSound";
import "./notifications.css";

const TOAST_DURATION_MS = 8_000;

const markRead = (id: string) =>
  ipc.send({ kind: "Notifications", command: { type: "markRead", payload: { id } } });
const dismiss = (id: string) =>
  ipc.send({ kind: "Notifications", command: { type: "dismiss", payload: { id } } });

function actionLabel(action: NotificationAction | null): string | null {
  if (!action) return null;
  switch (action.type) {
    case "openChat": return "Open chat";
    case "openMatchmaking": return "Open matchmaking";
    case "openCustomGames": return "Open games";
    case "acceptPartyInvite": return "Accept invite";
    case "watchLive": return "Watch replay";
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
    }
  }
  markRead(item.id);
}

function formatTime(timestamp: string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ""
    : new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function notificationTone(item: ClientNotification): string {
  if (item.kind === "error") return " is-error";
  if (item.kind === "serverWarning") return " is-warning";
  if (item.kind === "serverNotice") return " is-server";
  return "";
}

export function NotificationCenter() {
  const items = useAppStore((state) => state.state.notifications.items);
  const preferences = useAppStore((state) => state.state.settings.notifications);
  const [open, setOpen] = useState(false);
  const [toastIds, setToastIds] = useState<string[]>([]);
  const processed = useRef(new Set<string>());
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
    hideToast(id);
    // Keep the notification in the history, but prevent an unread item from
    // being surfaced again when another backend event refreshes the state.
    markRead(id);
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
    const fresh = items.filter((item) => !item.read && !processed.current.has(item.id));
    if (fresh.length === 0) return;
    fresh.forEach((item) => processed.current.add(item.id));
    if (!preferences.enabled) return;
    setToastIds((current) => [...fresh.map((item) => item.id), ...current].slice(0, 3));

    fresh.forEach((item) => {
      if (preferences.sound) {
        playNotificationAlert(
          preferences.volume,
          item.kind === "matchFound" || item.kind === "partyInvite",
        );
      }
    });
    if (preferences.desktop) {
      // Check focus and request permission once per batch. Parallel permission
      // prompts from several notifications are rejected on some platforms.
      void (async () => {
        const focused = await native.isWindowFocused().catch(() => true);
        if (focused && !preferences.notifyWhenFocused) return;
        if (!await native.ensureNotificationPermission()) return;
        fresh.forEach((item) => native.sendNotification(item.title, stripHtmlTags(item.body)));
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
        aria-label={unread ? `${unread} unread notifications` : "Notifications"}
        aria-expanded={open}
        title="Notifications"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="bell" size={16} />
        {unread > 0 && <span className="notification-badge">{unread > 99 ? "99+" : unread}</span>}
      </button>

      {open && (
        <section className="notification-panel" aria-label="Notifications">
          <header>
            <strong>Notifications</strong>
            {items.length > 0 && (
              <button type="button" onClick={clearAll}>
                Clear all
              </button>
            )}
          </header>
          <div className="notification-list">
            {items.length === 0 ? (
              <p className="notification-empty muted">You’re all caught up.</p>
            ) : items.map((item) => (
              <article className={`notification-item${item.read ? " is-read" : ""}${notificationTone(item)}`} key={item.id}>
                <button className="notification-content" type="button" onClick={() => handleAction(item)}>
                  <span className="notification-item-head"><strong>{item.title}</strong><time>{formatTime(item.createdAt)}</time></span>
                  <span>{renderFormattedText(item.body)}</span>
                  {actionLabel(item.action) && <em>{actionLabel(item.action)}</em>}
                </button>
                <button className="notification-dismiss" type="button" onClick={() => { hideToast(item.id); dismiss(item.id); }} aria-label={`Dismiss ${item.title}`}>
                  <Icon name="close" size={12} />
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      <div className="notification-toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((item) => (
          <article className={`notification-toast${notificationTone(item)}`} key={item.id}>
            <button type="button" onClick={() => handleAction(item)}>
              <strong>{item.title}</strong>
              <span>{renderFormattedText(item.body)}</span>
              {actionLabel(item.action) && <em>{actionLabel(item.action)}</em>}
            </button>
            <button
              type="button"
              className="notification-dismiss"
              onClick={() => {
                hideToast(item.id);
                dismiss(item.id);
              }}
              aria-label={`Dismiss ${item.title}`}
            >
              <Icon name="close" size={12} />
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
