// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationCenter } from "./NotificationCenter";
import { seedStore } from "../../testing/mounted";
import { clearSentCommands, sentCommands } from "../../testing/sentCommands";
import { playNotificationSound } from "./notificationSound";
import { useAppStore } from "../../store/store";
import type { ClientNotification } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";

vi.mock("../../ipc/client");
const nativeMock = vi.hoisted(() => ({
  isWindowFocused: vi.fn(() => Promise.resolve(false)),
  requestAttention: vi.fn(() => Promise.resolve()),
  showNotificationPopup: vi.fn(() => Promise.resolve()),
  ensureNotificationPermission: vi.fn(() => Promise.resolve(true)),
  sendNotification: vi.fn(),
  gameNotificationAttention: vi.fn(() => Promise.resolve(false)),
  nextNotificationActivation: vi.fn<(_acknowledgedId?: string) => Promise<ClientNotification | null>>(() => Promise.resolve(null)),
  onNotificationActivation: vi.fn<(_handler: () => void) => Promise<() => void>>(() => Promise.resolve(() => undefined)),
}));
vi.mock("../../ipc/native", () => ({ native: nativeMock }));
vi.mock("./notificationSound", () => ({ soundForKind: vi.fn(() => "silent"), playNotificationSound: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.mocked(nativeMock.isWindowFocused).mockResolvedValue(false);
  vi.mocked(nativeMock.showNotificationPopup).mockResolvedValue(undefined);
  vi.mocked(nativeMock.gameNotificationAttention).mockResolvedValue(false);
  nativeMock.nextNotificationActivation.mockReset().mockResolvedValue(null);
  seedStore((state) => ({ ...state, settings: { ...state.settings, notifications: {
    ...state.settings.notifications, desktopStyle: "popup", sound: false,
  } }, notifications: { items: [{ id: "match", kind: "matchFound", title: "Match found", body: "A match is ready", action: { type: "openMatchmaking" }, text: null, read: false, createdAt: new Date().toISOString() }] } }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("handles and acknowledges a popup clicked before the main window mounted", async () => {
  const item = useAppStore.getState().state.notifications.items[0];
  seedStore((state) => ({ ...state, notifications: { items: [] } }));
  clearSentCommands();
  nativeMock.nextNotificationActivation.mockResolvedValueOnce(item);
  render(<NotificationCenter />);
  await act(async () => {});
  expect(sentCommands()).toEqual([
    { kind: "Nav", command: { type: "select", payload: { tab: "play" } } },
    { kind: "Lobby", command: { type: "setPlayMode", payload: { mode: "matchmaking" } } },
    { kind: "Notifications", command: { type: "markRead", payload: { id: item.id } } },
  ]);
  expect(nativeMock.nextNotificationActivation.mock.calls).toEqual([[], [item.id]]);
});

it("checks again when a popup is clicked during an empty queue response", async () => {
  const item = useAppStore.getState().state.notifications.items[0];
  let finishFirst!: (item: ClientNotification | null) => void;
  const first = new Promise<ClientNotification | null>((resolve) => { finishFirst = resolve; });
  nativeMock.nextNotificationActivation.mockReturnValueOnce(first).mockResolvedValueOnce(item);
  render(<NotificationCenter />);
  await act(async () => {});
  const wake = nativeMock.onNotificationActivation.mock.calls[0][0];
  await act(async () => {
    wake();
    wake();
    finishFirst(null);
    await first;
  });
  expect(nativeMock.nextNotificationActivation.mock.calls).toEqual([[], [], [item.id]]);
});

it("shows a desktop popup in the background without a duplicate in-client or system popup", async () => {
  const view = render(<NotificationCenter />);
  await act(async () => {});
  expect(nativeMock.showNotificationPopup).toHaveBeenCalledOnce();
  expect(nativeMock.ensureNotificationPermission).not.toHaveBeenCalled();
  expect(nativeMock.sendNotification).not.toHaveBeenCalled();
  expect(view.container.querySelector(".notification-toast")).toBeNull();
  expect(useAppStore.getState().state.notifications.items[0].read).toBe(false);
});
it("uses the in-client card while focused unless desktop delivery while focused is enabled", async () => {
  vi.mocked(nativeMock.isWindowFocused).mockResolvedValue(true);
  const view = render(<NotificationCenter />);
  await act(async () => {});
  expect(nativeMock.showNotificationPopup).not.toHaveBeenCalled();
  expect(view.container.querySelector(".notification-toast")).not.toBeNull();
});
it("falls back to system notification when creating the popup fails", async () => {
  vi.mocked(nativeMock.showNotificationPopup).mockRejectedValue(new Error("Unavailable"));
  render(<NotificationCenter />);
  await act(async () => {});
  expect(nativeMock.ensureNotificationPermission).toHaveBeenCalledOnce();
  expect(nativeMock.sendNotification).toHaveBeenCalledOnce();
});

it("writes a notification that missed the desktop popup to the client log", async () => {
  const report = vi.spyOn(ipc, "reportNotificationSkip");
  vi.mocked(nativeMock.showNotificationPopup).mockRejectedValue(new Error("Unavailable"));
  render(<NotificationCenter />);
  await act(async () => {});
  expect(report).toHaveBeenCalledWith("matchFound", "desktopFailed", "Error: Unavailable");
});

it("logs nothing for a notification the popup delivered", async () => {
  const report = vi.spyOn(ipc, "reportNotificationSkip");
  render(<NotificationCenter />);
  await act(async () => {});
  expect(nativeMock.showNotificationPopup).toHaveBeenCalledOnce();
  expect(report).not.toHaveBeenCalled();
});

it("keeps game-full alerts quiet when the owned game is already foreground", async () => {
  seedStore((state) => ({ ...state, notifications: { items: [{ id: "full", kind: "gameFull", title: "Game full", body: "Ready", action: { type: "focusGame" }, text: null, read: false, createdAt: new Date().toISOString() }] } }));
  vi.mocked(nativeMock.gameNotificationAttention).mockResolvedValue(true);
  const view = render(<NotificationCenter />);
  await act(async () => {});
  expect(nativeMock.showNotificationPopup).not.toHaveBeenCalled();
  expect(nativeMock.requestAttention).not.toHaveBeenCalled();
  expect(playNotificationSound).not.toHaveBeenCalled();
  expect(view.container.querySelector(".notification-toast")).toBeNull();
});

it("uses the sound setting as it is after the focus check, not before it", async () => {
  let answer!: (focused: boolean) => void;
  nativeMock.isWindowFocused.mockReturnValue(new Promise<boolean>((done) => { answer = done; }));
  act(() => {
    const current = useAppStore.getState().state;
    useAppStore.getState().hydrate({ ...current, settings: { ...current.settings, notifications: { ...current.settings.notifications, sound: true } } });
  });
  render(<NotificationCenter />);
  await act(async () => {});
  act(() => {
    const current = useAppStore.getState().state;
    useAppStore.getState().hydrate({ ...current, settings: { ...current.settings, notifications: { ...current.settings.notifications, sound: false } } });
  });
  await act(async () => { answer(false); await Promise.resolve(); });
  expect(playNotificationSound).not.toHaveBeenCalled();
});

it("does not announce stale cards after notifications are disabled during popup creation", async () => {
  let reject!: (error: Error) => void;
  nativeMock.showNotificationPopup.mockReturnValue(new Promise<void>((_resolve, fail) => { reject = fail; }));
  const view = render(<NotificationCenter />);
  await act(async () => {});
  act(() => {
    const current = useAppStore.getState().state;
    useAppStore.getState().hydrate({ ...current, settings: { ...current.settings, notifications: { ...current.settings.notifications, enabled: false } } });
  });
  await act(async () => { reject(new Error("Popup unavailable")); await Promise.resolve(); });
  expect(nativeMock.ensureNotificationPermission).not.toHaveBeenCalled();
  expect(nativeMock.sendNotification).not.toHaveBeenCalled();
  expect(view.container.querySelector(".notification-toast")).toBeNull();
});

it("queues in-client bursts and gives the next card the full configured display duration", async () => {
  vi.useFakeTimers();
  seedStore((state) => ({ ...state, settings: { ...state.settings, notifications: {
    ...state.settings.notifications, desktop: false, popup: true, enabled: true,
    toastDurationSeconds: 12, repeatCooldownSeconds: 0,
  } }, notifications: { items: Array.from({ length: 5 }, (_,index) => ({
    ...state.notifications.items[0], id: `message-${index}`, title: `Message ${index}`,
  })) } }));
  const view = render(<NotificationCenter />);
  await act(async () => {});
  expect(view.container.querySelectorAll(".notification-toast")).toHaveLength(3);
  expect(view.container.textContent).not.toContain("Message 3");
  await act(async () => { await vi.advanceTimersByTimeAsync(11999); });
  expect(view.container.textContent).toContain("Message 0");
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(view.container.querySelectorAll(".notification-toast")).toHaveLength(2);
  expect(view.container.textContent).toContain("Message 3");
  expect(view.container.textContent).toContain("Message 4");
  await act(async () => { await vi.advanceTimersByTimeAsync(11999); });
  expect(view.container.querySelectorAll(".notification-toast")).toHaveLength(2);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(view.container.querySelector(".notification-toast")).toBeNull();
});

it("shows an urgent match immediately while preserving the displaced in-client card", async () => {
  vi.useFakeTimers();
  seedStore((state) => ({ ...state, settings: { ...state.settings, notifications: {
    ...state.settings.notifications, desktop: false, popup: true, enabled: true,
    toastDurationSeconds: 12, repeatCooldownSeconds: 0,
  } }, notifications: { items: Array.from({ length: 3 }, (_,index) => ({
    ...state.notifications.items[0], id: `message-${index}`, title: `Message ${index}`, kind: "friendOnline",
  })) } }));
  const view = render(<NotificationCenter />);
  await act(async () => {});
  act(() => {
    const state = useAppStore.getState().state;
    useAppStore.getState().hydrate({ ...state, notifications: { items: [{
      ...state.notifications.items[0], id: "urgent", title: "Urgent match", kind: "matchFound",
    }, ...state.notifications.items] } });
  });
  await act(async () => {});
  expect(view.container.querySelectorAll(".notification-toast")).toHaveLength(3);
  expect(view.container.textContent).toContain("Urgent match");
  expect(view.container.textContent).not.toContain("Message 2");
  await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
  expect(view.container.textContent).toContain("Message 2");
});

it("marks the bell's unread entries in one command and keeps their new markers", async () => {
  const at = new Date().toISOString();
  const entry = (id: string, read: boolean) => ({ id, kind: "friendJoinedGame" as const, title: id, body: "", action: null, text: null, read, createdAt: at });
  seedStore((state) => ({ ...state, notifications: { items: [entry("new", false), entry("seen", true), entry("newer", false)] } }));
  const view = render(<NotificationCenter />);
  await act(async () => {});
  clearSentCommands();
  act(() => view.container.querySelector<HTMLButtonElement>(".notification-bell")!.click());
  expect(sentCommands()).toEqual([
    { kind: "Notifications", command: { type: "markReadMany", payload: { ids: ["new", "newer"] } } },
  ]);
  // The backend's answer: both are read now, and the badge goes.
  act(() => {
    const current = useAppStore.getState().state;
    useAppStore.getState().hydrate({ ...current, notifications: { items: current.notifications.items.map((item) => ({ ...item, read: true })) } });
  });
  expect(view.container.querySelector(".notification-badge")).toBeNull();
  const entries = [...view.container.querySelectorAll(".notification-item")];
  expect(entries.map((item) => item.classList.contains("is-read"))).toEqual([false, true, false]);
});
