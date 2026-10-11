// @vitest-environment happy-dom
//
// The starting dialog's bar fills when the step in hand is measured (the
// replay's own download, an engine file) and sweeps when it is not.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ReplayEvent } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent } from "../../testing/mounted";
import { ReplayStartDialog } from "./ReplayStartDialog";

vi.mock("../../ipc/client");

failOnConsoleError();

const replayEvent = (event: ReplayEvent) => applyEvent({ kind: "Replays", event });

describe("ReplayStartDialog", () => {
  it("fills its bar for a measured step and sweeps for one that is not", () => {
    render(<ReplayStartDialog />);
    replayEvent({ type: "connecting" });
    replayEvent({ type: "preparing", payload: { step: { detail: "Downloading replay 42", progress: 40 } } });

    const bar = screen.getByRole("progressbar", { name: "Starting the replay" });
    expect(bar.getAttribute("aria-valuenow")).toBe("40");
    expect(bar.getAttribute("data-indeterminate")).toBeNull();

    replayEvent({ type: "preparing", payload: { step: { detail: "Unpacking the replay", progress: null } } });
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("data-indeterminate")).toBe("true");
  });
});
