// @vitest-environment happy-dom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationCenter } from "./NotificationCenter";
import { seedStore } from "../../testing/mounted";
import { playNotificationSound } from "./notificationSound";
import { useAppStore } from "../../store/store";

vi.mock("../../ipc/client");
const nativeMock = vi.hoisted(() => ({
  isWindowFocused: vi.fn(() => Promise.resolve(false)),
  requestAttention: vi.fn(() => Promise.resolve()),
  showNotificationPopup: vi.fn(() => Promise.resolve()),
  ensureNotificationPermission: vi.fn(() => Promise.resolve(true)),
  sendNotification: vi.fn(),
  gameNotificationAttention: vi.fn(() => Promise.resolve(false)),
  onNotificationInteraction: vi.fn(() => Promise.resolve(() => undefined)),
}));
vi.mock("../../ipc/native", () => ({ native: nativeMock }));
vi.mock("./notificationSound", () => ({ soundForKind: vi.fn(() => "silent"), playNotificationSound: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  vi.mocked(nativeMock.isWindowFocused).mockResolvedValue(false);
  vi.mocked(nativeMock.showNotificationPopup).mockResolvedValue(undefined);
  vi.mocked(nativeMock.gameNotificationAttention).mockResolvedValue(false);
  seedStore((state) => ({ ...state, settings: { ...state.settings, notifications: {
    ...state.settings.notifications, desktopStyle: "popup", sound: false,
  } }, notifications: { items: [{ id: "match", kind: "matchFound", title: "Match found", body: "A match is ready", action: { type: "openMatchmaking" }, text: null, read: false, createdAt: new Date().toISOString() }] } }));
});
afterEach(() => vi.restoreAllMocks());
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
