// @vitest-environment happy-dom
//
// The starting dialog's bar fills when the step in hand is measured (the
// replay's own download, an engine file) and sweeps when it is not.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ReplayEvent, VaultReplay } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, seedStore, sentCommands } from "../../testing/mounted";
import { ReplayStartDialog } from "./ReplayStartDialog";

vi.mock("../../ipc/client");

failOnConsoleError();

const replayEvent = (event: ReplayEvent) => applyEvent({ kind: "Replays", event });

describe("ReplayStartDialog", () => {
  it("fills its bar for a measured step and sweeps for one that is not", () => {
    render(<ReplayStartDialog />);
    replayEvent({ type: "connecting", payload: { launch: { type: "vault", payload: { uid: 42 } } } });
    replayEvent({ type: "preparing", payload: { step: { detail: "Downloading replay 42", progress: 40 } } });

    const bar = screen.getByRole("progressbar", { name: "Starting the replay" });
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.getAttribute("data-indeterminate")).toBeNull();

    replayEvent({ type: "preparing", payload: { step: { detail: "Unpacking the replay", progress: null } } });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("data-indeterminate")).toBe("true");
  });

  it("names the replay it starts from the vault listing", () => {
    seedStore((state) => ({
      ...state,
      replays: {
        ...state.replays,
        vault: [{ uid: 42, title: "Ladder night", map: "scmp_009", mapThumbnailUrl: "" } as VaultReplay],
      },
    }));
    render(<ReplayStartDialog />);
    replayEvent({ type: "connecting", payload: { launch: { type: "vault", payload: { uid: 42 } } } });

    expect(screen.getByText("Ladder night")).toBeDefined();
    expect(screen.getByText(/#42/)).toBeDefined();
  });

  it("stops showing itself with one patchGame", async () => {
    const user = userEvent.setup();
    render(<ReplayStartDialog />);
    replayEvent({ type: "connecting", payload: { launch: { type: "vault", payload: { uid: 42 } } } });
    await user.click(screen.getByRole("button", { name: "Do not show again" }));

    expect(sentCommands()).toEqual([
      { kind: "Settings", command: { type: "patchGame", payload: { patch: { showReplayProgress: false } } } },
    ]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
