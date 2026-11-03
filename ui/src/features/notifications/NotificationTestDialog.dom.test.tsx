// @vitest-environment happy-dom
import { StrictMode } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationTestDialog } from "./NotificationTestDialog";
import { seedStore, sentCommands } from "../../testing/mounted";
import { useAppStore } from "../../store/store";
import { en } from "../../i18n/catalog/en";
import { sampleNotification, NOTIFICATION_SAMPLES } from "./notificationSamples";
import type { NotificationKind } from "../../ipc/bindings";
import type { NotificationPopupCard } from "../../ipc/native";

vi.mock("../../ipc/client");
const bridge = vi.hoisted(() => ({
  isWindowFocused: vi.fn(() => Promise.resolve(false)), requestAttention: vi.fn(() => Promise.resolve()),
  showNotificationPopup: vi.fn<(cards: NotificationPopupCard[], dismissLabel: string, preview?: boolean, hold?: boolean) => Promise<void>>(() => Promise.resolve()), ensureNotificationPermission: vi.fn(() => Promise.resolve(true)),
  sendNotification: vi.fn(), gameNotificationAttention: vi.fn(() => Promise.resolve(false)),
  notificationPopupInteract: vi.fn<(id: string, interaction: string) => Promise<void>>(() => Promise.resolve()),
  onNotificationInteraction: vi.fn(() => Promise.resolve(vi.fn())),
}));
vi.mock("../../ipc/native", () => ({ native: bridge }));
vi.mock("./notificationSound", async (original) => ({ ...await original<object>(), playNotificationSound: vi.fn() }));
const text = (key: keyof typeof en) => en[key] as string;
const choose = (key: keyof typeof en, value: string) => fireEvent.change(screen.getByRole("combobox", { name: text(key) }), { target: { value } });
const flush = () => act(async () => { await Promise.resolve(); });
beforeEach(() => {
  vi.clearAllMocks();
  bridge.showNotificationPopup.mockResolvedValue(undefined);
  bridge.isWindowFocused.mockResolvedValue(false);
  bridge.ensureNotificationPermission.mockResolvedValue(true);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  seedStore((state) => ({ ...state, settings: { ...state.settings, notifications: {
    ...state.settings.notifications, enabled: true, desktop: true, desktopStyle: "popup", sound: false,
    newCustomGames: false, repeatCooldownSeconds: 30,
  } } }));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("covers all event kinds with translated local samples and local artwork", () => {
  for (const kind of Object.keys(NOTIFICATION_SAMPLES) as NotificationKind[]) {
    const { item, artwork } = sampleNotification(kind, "preview:test");
    expect(item.title).not.toMatch(/\{\w+\}/);
    expect(item.body).not.toMatch(/\{\w+\}/);
    expect(artwork === null || artwork.startsWith("/assets/")).toBe(true);
  }
});

it("shows all three real card layouts and simulates dangerous actions without commands", async () => {
  render(<NotificationTestDialog onClose={vi.fn()} />);
  await flush();
  expect(within(screen.getByRole("combobox", { name: text("notifications.test.event") })).getAllByRole("option")).toHaveLength(27);
  choose("notifications.test.event", "partyInvite");
  fireEvent.click(document.querySelector(".desktop-notification-main")!);
  expect(screen.getByRole("log").textContent).toContain(text("notifications.test.result.activated"));
  fireEvent.click(screen.getByRole("button", { name: text("notifications.test.surface.toast") }));
  expect(document.querySelector(".notification-test-gallery .notification-toast")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: text("notifications.test.surface.history") }));
  expect(document.querySelector(".notification-test-gallery .notification-item")).not.toBeNull();
  expect(sentCommands()).toEqual([]);
  expect(bridge.showNotificationPopup).not.toHaveBeenCalled();
});

it("delays a three-card native preview and removes only its owned previews on close", async () => {
  vi.useFakeTimers();
  const view = render(<NotificationTestDialog onClose={vi.fn()} />);
  await flush();
  choose("notifications.test.scenario", "burst"); choose("notifications.test.delay", "5");
  fireEvent.click(screen.getByRole("button", { name: text("notifications.test.showDesktop") }));
  await act(async () => { await vi.advanceTimersByTimeAsync(4999); });
  expect(bridge.showNotificationPopup).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  const cards = bridge.showNotificationPopup.mock.calls[0][0];
  expect(cards).toHaveLength(3);
  expect(cards.every((card: { id: string }) => card.id.startsWith("preview:"))).toBe(true);
  view.unmount();
  expect(bridge.notificationPopupInteract.mock.calls.map(([id]) => id)).toEqual(cards.map((card: { id: string }) => card.id));
  expect(sentCommands()).toEqual([]);
});

it("cancels a scheduled notification when the dialog unmounts", async () => {
  vi.useFakeTimers();
  const view = render(<NotificationTestDialog onClose={vi.fn()} />); await flush();
  choose("notifications.test.delay", "5");
  fireEvent.click(screen.getByRole("button", { name: text("notifications.test.showDesktop") }));
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
  expect(bridge.showNotificationPopup).not.toHaveBeenCalled();
});

it("keeps gallery previews visible and cancels a native test that never acknowledges display", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  bridge.showNotificationPopup.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  render(<NotificationTestDialog onClose={vi.fn()} />); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(document.querySelector(".notification-test-gallery .desktop-notification")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: text("notifications.test.showDesktop") })); await flush();
  await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
  expect(screen.getByRole("log").textContent).toContain(text("notifications.test.timeout"));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: text("notifications.test.showDesktop") }).disabled).toBe(false);
  expect(bridge.notificationPopupInteract).toHaveBeenCalled();
  await act(async () => { finish(); await Promise.resolve(); });
  expect(screen.getByRole("log").textContent).not.toContain(text("notifications.test.result.desktop"));
});

it("rereads settings after an OS permission prompt before sending a fallback", async () => {
  let finish!: (allowed: boolean) => void;
  bridge.showNotificationPopup.mockRejectedValue(new Error("Unavailable"));
  bridge.ensureNotificationPermission.mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
  render(<NotificationTestDialog onClose={vi.fn()} />); await flush();
  choose("notifications.test.mode", "delivery");
  fireEvent.click(screen.getByRole("button", { name: text("notifications.test.send") })); await flush();
  act(() => {
    const state = useAppStore.getState().state;
    useAppStore.getState().hydrate({ ...state, settings: { ...state.settings, notifications: { ...state.settings.notifications, desktop: false } } });
  });
  await act(async () => { finish(true); await Promise.resolve(); });
  expect(bridge.sendNotification).not.toHaveBeenCalled();
});

it("explains event filtering and the same repeat cooldown used by live delivery", async () => {
  render(<NotificationTestDialog onClose={vi.fn()} />); await flush();
  choose("notifications.test.mode", "delivery"); choose("notifications.test.event", "newCustomGame");
  fireEvent.click(screen.getByRole("button", { name: text("notifications.test.send") })); await flush();
  expect(screen.getByRole("log").textContent).toContain(text("notifications.test.result.eventDisabled"));
  expect(bridge.showNotificationPopup).not.toHaveBeenCalled();
  choose("notifications.test.event", "matchFound"); choose("notifications.test.scenario", "repeat");
  fireEvent.click(screen.getByRole("button", { name: text("notifications.test.send") })); await flush();
  expect(screen.getByRole("log").textContent).toContain(text("notifications.test.result.cooldown"));
  expect(screen.getByRole("log").textContent).toContain(text("notifications.test.result.desktop"));
  expect(bridge.showNotificationPopup.mock.calls[0][0]).toHaveLength(1);
  expect(useAppStore.getState().state.notifications.items).toHaveLength(0);
  expect(sentCommands()).toEqual([]);
});

it("reports a failed native popup and permission denial while showing the real fallback toast", async () => {
  bridge.showNotificationPopup.mockRejectedValue(new Error("Window unavailable"));
  bridge.ensureNotificationPermission.mockResolvedValue(false);
  render(<NotificationTestDialog onClose={vi.fn()} />); await flush();
  choose("notifications.test.mode", "delivery");
  fireEvent.click(screen.getByRole("button", { name: text("notifications.test.send") })); await flush();
  expect(screen.getByRole("log").textContent).toContain(text("notifications.test.result.desktopFailed"));
  expect(screen.getByRole("log").textContent).toContain(text("notifications.test.result.permissionDenied"));
  expect(document.querySelector(".notification-test-toasts .notification-toast")).not.toBeNull();
  expect(bridge.sendNotification).not.toHaveBeenCalled();
});

it("disposes both subscriptions correctly under StrictMode", async () => {
  const first = vi.fn(); const second = vi.fn();
  bridge.onNotificationInteraction.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const view = render(<StrictMode><NotificationTestDialog onClose={vi.fn()} /></StrictMode>); await flush();
  expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
  view.unmount(); expect(second).toHaveBeenCalledOnce();
});
