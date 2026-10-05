// @vitest-environment happy-dom
//
// The replay panel's enlarged map preview is drawn in the panel's own markup
// and registers its own overlay layer, so Escape has two things to close and
// must close them one at a time, the preview first.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { overlayStack } from "../../design-system/overlayStack";
import type { VaultReplay } from "../../ipc/bindings";
import "../../testing/mounted";
import { ReplayDetailPanel } from "./ReplayDetailPanel";

vi.mock("../../ipc/client");

const replay: VaultReplay = {
  uid: 4242,
  title: "Ladder night",
  map: "scmp_009",
  mapThumbnailUrl: "",
  modName: "faf",
  startTime: "2026-01-02T18:00:00Z",
  replayAvailable: true,
  durationSeconds: 1_200,
  gameDurationSeconds: 1_100,
  teams: [],
  averageRating: 1_500,
  quality: 80,
  reviewsAverage: null,
  reviewsCount: null,
  gameVersion: null,
};

function mountPanel() {
  const onClose = vi.fn();
  const view = render(<ReplayDetailPanel replay={replay} busy={false} onClose={onClose} onWatch={() => undefined} />);
  return { onClose, ...view };
}

describe("ReplayDetailPanel, mounted", () => {
  it("closes the enlarged preview on the first Escape and the panel on the second", async () => {
    const user = userEvent.setup();
    const { onClose } = mountPanel();
    const panel = screen.getByRole("dialog", { name: "Replay Ladder night" });

    await user.click(screen.getByRole("button", { name: /^Enlarge the .* preview$/ }));
    expect(screen.getAllByRole("dialog")).toHaveLength(2);

    await user.keyboard("{Escape}");
    expect(screen.getAllByRole("dialog")).toEqual([panel]);
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes the preview from its own close button without closing the panel", async () => {
    const user = userEvent.setup();
    const { onClose } = mountPanel();

    await user.click(screen.getByRole("button", { name: /^Enlarge the .* preview$/ }));
    const preview = screen.getAllByRole("dialog")[1];
    const closeButtons = screen.getAllByRole("button", { name: "Close" }).filter((button) => preview.contains(button));
    expect(closeButtons).toHaveLength(1);

    await user.click(closeButtons[0]);
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
    // The preview's layer went with it: the next Escape is the panel's.
    expect(overlayStack.size()).toBe(1);
  });

  it("takes both layers off the stack when the panel goes away with the preview open", async () => {
    const user = userEvent.setup();
    const { unmount } = mountPanel();
    await user.click(screen.getByRole("button", { name: /^Enlarge the .* preview$/ }));
    expect(overlayStack.size()).toBe(2);

    unmount();
    expect(overlayStack.size()).toBe(0);
  });
});
