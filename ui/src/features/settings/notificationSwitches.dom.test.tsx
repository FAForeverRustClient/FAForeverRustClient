// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { NotificationsSettingsSection } from "./NotificationsSettingsSection";
import { useAppStore } from "../../store/store";
import { en } from "../../i18n/catalog/en";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { failOnConsoleError } from "../../testing/consoleGuard";

const nativeMock = vi.hoisted(() => ({
  listNotificationSounds: vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
  notificationDisplays: vi.fn(() => Promise.resolve([])),
  selectFile: vi.fn<() => Promise<string | null>>(() => Promise.resolve(null)),
  importNotificationSound: vi.fn<(path: string) => Promise<string>>(() => Promise.resolve("")),
}));
vi.mock("../../ipc/client");
vi.mock("../../ipc/native", () => ({ native: nativeMock }));
vi.mock("../notifications/notificationSound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../notifications/notificationSound")>();
  return { ...actual, playNotificationSound: vi.fn() };
});
failOnConsoleError();

async function mountNotifications() {
  seedStore(state => ({ ...state, settings: { ...state.settings, notifications: {
    ...state.settings.notifications, enabled: true, sound: true, desktop: true,
    friendOnline: false, friendOffline: false, friendPlaying: false,
    newCustomGames: false, newCustomGamesFriendsOnly: true,
  } } }));
  await act(async () => {
    render(<NotificationsSettingsSection />);
    await Promise.resolve();
  });
}

it.each([
  ["settings.notifications.draftTurn", "draftTurn"],
  ["settings.notifications.friendOnline", "friendOnline"],
  ["settings.notifications.friendOffline", "friendOffline"],
  ["settings.notifications.friendPlaying", "friendPlaying"],
  ["settings.notifications.newGames", "newCustomGames"],
] as const)("changes the off notification %s in both directions", async (label, field) => {
  await mountNotifications();
  const user = userEvent.setup();
  const input = screen.getByRole<HTMLInputElement>("checkbox", { name: en[label] });
  expect(input.disabled).toBe(false);
  expect(input.checked).toBe(false);
  await user.click(input);
  expect(sentCommands()).toEqual([{ kind: "Settings", command: { type: "patchNotifications", payload: { patch: { [field]: true } } } }]);
  applyEvent({ kind: "Settings", event: { field: "notifications", value: {
    ...useAppStore.getState().state.settings.notifications, [field]: true,
  } } });
  expect(input.checked).toBe(true);
  clearSentCommands();
  await user.click(input);
  expect(sentCommands()).toEqual([{ kind: "Settings", command: { type: "patchNotifications", payload: { patch: { [field]: false } } } }]);
});

it("keeps the new-game and friends-only descriptions visible when notifications are enabled", async () => {
  await mountNotifications();
  const user = userEvent.setup();
  const friendsOnly = screen.getByRole<HTMLInputElement>("checkbox", { name: en["settings.notifications.friendsGamesOnly"] });
  expect(friendsOnly.checked).toBe(true);
  expect(friendsOnly.disabled).toBe(true);
  expect(screen.getByText(en["settings.notifications.newGamesHint"])).toBeTruthy();
  expect(screen.getByText(en["settings.notifications.friendsGamesOnlyHint"])).toBeTruthy();
  await user.click(friendsOnly);
  expect(sentCommands()).toHaveLength(0);
  await user.click(screen.getByRole("checkbox", { name: en["settings.notifications.newGames"] }));
  applyEvent({ kind: "Settings", event: { field: "notifications", value: {
    ...useAppStore.getState().state.settings.notifications, newCustomGames: true,
  } } });
  expect(friendsOnly.disabled).toBe(false);
  expect(screen.getByText(en["settings.notifications.newGamesHint"])).toBeTruthy();
  expect(screen.getByText(en["settings.notifications.friendsGamesOnlyHint"])).toBeTruthy();
  clearSentCommands();
  await user.click(friendsOnly);
  expect(sentCommands()).toEqual([{ kind: "Settings", command: { type: "patchNotifications", payload: { patch: { newCustomGamesFriendsOnly: false } } } }]);
});

it("announces a lobby filling again by default, and can be switched off with full-lobby alerts on", async () => {
  await mountNotifications();
  const user = userEvent.setup();
  const repeats = screen.getByRole<HTMLInputElement>("checkbox", { name: en["settings.notifications.gameFullRepeats"] });
  expect(repeats.checked).toBe(true);
  expect(repeats.disabled).toBe(false);
  expect(screen.getByText(en["settings.notifications.gameFullRepeatsHint"])).toBeTruthy();
  await user.click(repeats);
  expect(sentCommands()).toEqual([{ kind: "Settings", command: { type: "patchNotifications", payload: { patch: { gameFullRepeats: false } } } }]);
  applyEvent({ kind: "Settings", event: { field: "notifications", value: {
    ...useAppStore.getState().state.settings.notifications, gameFullRepeats: false, gameFull: false,
  } } });
  expect(repeats.checked).toBe(false);
  expect(repeats.disabled).toBe(true);
});

it("offers one shared popup duration control and saves a longer display time", async () => {
  await mountNotifications();
  const duration = screen.getByRole<HTMLInputElement>("spinbutton", { name: en["settings.notifications.duration"] });
  expect(duration.min).toBe("2");
  expect(duration.max).toBe("60");
  expect(screen.getByText(en["settings.notifications.durationHint"])).toBeTruthy();
  fireEvent.change(duration, { target: { value: "15" } });
  expect(sentCommands()).toEqual([{ kind: "Settings", command: { type: "patchNotifications", payload: { patch: { toastDurationSeconds: 15 } } } }]);
  applyEvent({ kind: "Settings", event: { field: "notifications", value: {
    ...useAppStore.getState().state.settings.notifications, toastDurationSeconds: 15,
  } } });
  fireEvent.blur(duration);
  expect(duration.value).toBe("15");
});

it("adds an imported custom sound to the dropdown immediately and selects it in the requesting row", async () => {
  nativeMock.listNotificationSounds.mockReset().mockResolvedValueOnce([]).mockImplementationOnce(() => new Promise(() => undefined));
  nativeMock.selectFile.mockResolvedValueOnce("/tmp/horn.wav");
  nativeMock.importNotificationSound.mockResolvedValueOnce("horn.wav");
  await mountNotifications();
  const select = screen.getByRole<HTMLSelectElement>("combobox", {
    name: `Sound for ${en["settings.notifications.matchFound"]}`,
  });
  await act(async () => {
    fireEvent.change(select, { target: { value: "add-a-sound" } });
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(sentCommands()).toContainEqual({
    kind: "Settings",
    command: { type: "patchNotifications", payload: { patch: { sounds: { matchFound: { custom: "horn.wav" } } } } },
  });
  applyEvent({
    kind: "Settings",
    event: {
      field: "notifications",
      value: {
        ...useAppStore.getState().state.settings.notifications,
        sounds: { ...useAppStore.getState().state.settings.notifications.sounds, matchFound: { custom: "horn.wav" } },
      },
    },
  });
  expect(select.value).toBe("custom:horn.wav");
  expect([...select.options].map((option) => option.textContent)).not.toContain("horn.wav (missing)");
});

it("does not overwrite a newer sound choice when an older file import finishes later", async () => {
  let resolveImport!: (stored: string) => void;
  nativeMock.listNotificationSounds.mockReset().mockResolvedValue([]);
  nativeMock.selectFile.mockResolvedValueOnce("/tmp/slow.wav");
  nativeMock.importNotificationSound.mockReturnValueOnce(
    new Promise<string>((resolve) => { resolveImport = resolve; }),
  );
  await mountNotifications();
  const select = screen.getByRole<HTMLSelectElement>("combobox", {
    name: `Sound for ${en["settings.notifications.matchFound"]}`,
  });
  await act(async () => {
    fireEvent.change(select, { target: { value: "add-a-sound" } });
    await Promise.resolve();
  });
  clearSentCommands();
  fireEvent.change(select, { target: { value: "ping" } });
  expect(sentCommands()).toEqual([
    { kind: "Settings", command: { type: "patchNotifications", payload: { patch: { sounds: { matchFound: "ping" } } } } },
  ]);
  clearSentCommands();
  await act(async () => {
    resolveImport("slow.wav");
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(sentCommands()).toEqual([]);
});
