// @vitest-environment happy-dom
//
// The shell asks "close during a game?" through this page only while the
// page says it is listening. Unmounted (the error screen replaced the app) or
// unloading, it has to say it stopped, or a close is sent to nobody and the
// close button does nothing.

import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({
  unlisten: vi.fn(),
  onRequestExitConfirm: vi.fn(),
  pageReady: vi.fn(() => Promise.resolve()),
  pageGone: vi.fn(() => Promise.resolve()),
}));
shell.onRequestExitConfirm.mockImplementation(() => Promise.resolve(shell.unlisten));

vi.mock("../../ipc/native", () => ({ native: shell }));
vi.mock("../../ipc/client");

import { ExitGuard } from "./ExitGuard";

describe("the close confirmation", () => {
  it("says it is ready once listening, and gone when it unmounts or the page leaves", async () => {
    const { unmount } = render(<ExitGuard />);
    await waitFor(() => expect(shell.pageReady).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new Event("pagehide"));
    expect(shell.pageGone).toHaveBeenCalledTimes(1);

    unmount();
    expect(shell.pageGone).toHaveBeenCalledTimes(2);
    expect(shell.unlisten).toHaveBeenCalledTimes(1);
  });
});
