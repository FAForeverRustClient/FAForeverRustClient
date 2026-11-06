// @vitest-environment happy-dom
import { fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { ClientNotification } from "../../ipc/bindings";
import { NotificationCard } from "./NotificationCard";
import "../../testing/mounted";

const item: ClientNotification = {
  id: "example", kind: "friendPlaying", title: "Watch friends playing live",
  body: "A team game", createdAt: "2026-11-04T20:52:00Z", read: false, text: null,
  action: { type: "watchLive", payload: { target: { uid: 1, modName: "faf", map: "example" } } },
};

it("activates the action and dismisses the entry through independent controls", async () => {
  const activate = vi.fn(), dismiss = vi.fn();
  const view = render(<NotificationCard item={item} artwork="/assets/mapgen-placeholder.png" history
    onActivate={activate} onDismiss={dismiss} />);
  fireEvent.click(view.getByText("Watch replay"));
  expect(activate).toHaveBeenCalledOnce();
  expect(dismiss).not.toHaveBeenCalled();
  const close = view.getByRole("button", { name: /Dismiss/ });
  const user = userEvent.setup();
  close.focus();
  await user.keyboard("{Enter}");
  expect(dismiss).toHaveBeenCalledOnce();
  expect(activate).toHaveBeenCalledOnce();
  expect(close.querySelector("time")).toBeNull();
  expect(view.container.querySelector(".notification-text time")).not.toBeNull();
});

it("keeps recovery controls outside the entry's activation and dismissal row", () => {
  const retry = vi.fn();
  const view = render(<NotificationCard item={{ ...item, action: null }} artwork={null} history
    onActivate={vi.fn()} onDismiss={vi.fn()}
    recovery={<div className="notification-recovery"><button onClick={retry}>Retry</button></div>} />);
  const entry = view.container.querySelector(".notification-entry")!;
  expect(entry.querySelectorAll("button")).toHaveLength(2);
  expect(entry.querySelector(".notification-recovery")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
});
