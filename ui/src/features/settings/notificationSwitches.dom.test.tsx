// @vitest-environment happy-dom

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { NotificationsSettingsSection } from "./NotificationsSettingsSection";
import { useAppStore } from "../../store/store";
import { en } from "../../i18n/catalog/en";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { failOnConsoleError } from "../../testing/consoleGuard";

vi.mock("../../ipc/client");
vi.mock("../../ipc/native", () => ({ native: {
  listNotificationSounds: () => Promise.resolve([]),
  notificationDisplays: () => Promise.resolve([]),
} }));
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
  applyEvent({ kind: "Settings", event: { type: "notificationsChanged", payload: { preferences: {
    ...useAppStore.getState().state.settings.notifications, [field]: true,
  } } } });
  expect(input.checked).toBe(true);
  clearSentCommands();
  await user.click(input);
  expect(sentCommands()).toEqual([{ kind: "Settings", command: { type: "patchNotifications", payload: { patch: { [field]: false } } } }]);
});

it("explains and enables the friends-only setting when new-game notifications are enabled", async () => {
  await mountNotifications();
  const user = userEvent.setup();
  const friendsOnly = screen.getByRole<HTMLInputElement>("checkbox", { name: en["settings.notifications.friendsGamesOnly"] });
  expect(friendsOnly.checked).toBe(true);
  expect(friendsOnly.disabled).toBe(true);
  expect(screen.getByText(en["settings.notifications.friendsGamesOnlyHint"])).toBeTruthy();
  await user.click(friendsOnly);
  expect(sentCommands()).toHaveLength(0);
  await user.click(screen.getByRole("checkbox", { name: en["settings.notifications.newGames"] }));
  applyEvent({ kind: "Settings", event: { type: "notificationsChanged", payload: { preferences: {
    ...useAppStore.getState().state.settings.notifications, newCustomGames: true,
  } } } });
  expect(friendsOnly.disabled).toBe(false);
  expect(screen.queryByText(en["settings.notifications.friendsGamesOnlyHint"])).toBeNull();
  clearSentCommands();
  await user.click(friendsOnly);
  expect(sentCommands()).toEqual([{ kind: "Settings", command: { type: "patchNotifications", payload: { patch: { newCustomGamesFriendsOnly: false } } } }]);
});
