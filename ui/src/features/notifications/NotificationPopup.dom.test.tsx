// @vitest-environment happy-dom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationPopup } from "./NotificationPopup";
import type { NotificationPopupBatch } from "../../ipc/native";
import "../../testing/mounted";

const bridge = vi.hoisted(() => ({
  listener: null as ((batch: NotificationPopupBatch) => void) | null,
  snapshot: vi.fn<() => Promise<NotificationPopupBatch>>(),
  size: vi.fn(() => Promise.resolve()),
  interact: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../ipc/native", () => ({ native: {
  onNotificationPopup: (listener: (batch: NotificationPopupBatch) => void) => {
    bridge.listener = listener; return Promise.resolve(() => { bridge.listener = null; });
  },
  notificationPopupSnapshot: bridge.snapshot,
  notificationPopupSize: bridge.size,
  notificationPopupInteract: bridge.interact,
} }));

afterEach(() => vi.unstubAllGlobals());

const batch = (revision: number, body: string): NotificationPopupBatch => ({ revision,
  cards: [{ id: "match", title: "Match found", body, tone: "", actionLabel: null }],
  theme: "forgeDark", dismissLabel: "Dismiss notification", durationSeconds: 60,
});
beforeEach(() => {
  vi.clearAllMocks();
  bridge.snapshot.mockResolvedValue(batch(1, "Ready"));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
it("renders remote message text as text and sends only the clicked id and interaction", async () => {
  bridge.snapshot.mockResolvedValue(batch(1, "<img src=x onerror=alert(1)>"));
  const view = render(<NotificationPopup />);
  await act(async () => {});
  expect(view.container.querySelector("img")).toBeNull();
  expect(view.container.textContent).toContain("<img src=x onerror=alert(1)>");
  fireEvent.click(view.container.querySelector(".desktop-notification-main")!);
  expect(bridge.interact).toHaveBeenCalledWith("match", "activate");
  fireEvent.click(view.getByRole("button", { name: "Dismiss notification" }));
  expect(bridge.interact).toHaveBeenCalledWith("match", "dismiss");
});
it("shows why an action failed inside the card that was clicked", async () => {
  bridge.interact.mockImplementationOnce(() => Promise.reject(new Error("No running game is available")));
  const view = render(<NotificationPopup />);
  await act(async () => {});
  fireEvent.click(view.container.querySelector(".desktop-notification-main")!);
  await act(async () => { await Promise.resolve(); });
  const card = view.container.querySelector(".desktop-notification")!;
  expect(card.querySelector("[role=alert]")?.textContent).toContain("No running game is available");
});
it("does not overwrite a newer live update with a delayed startup snapshot", async () => {
  let resolve!: (batch: NotificationPopupBatch) => void;
  bridge.snapshot.mockReturnValue(new Promise((done) => { resolve = done; }));
  const view = render(<NotificationPopup />);
  await act(async () => {});
  act(() => { bridge.listener?.(batch(2, "New arrival")); });
  await act(async () => { resolve(batch(1, "Old snapshot")); await Promise.resolve(); });
  expect(view.container.textContent).toContain("New arrival");
  expect(view.container.textContent).not.toContain("Old snapshot");
});
