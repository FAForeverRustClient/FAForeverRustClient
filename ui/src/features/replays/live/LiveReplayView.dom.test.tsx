// @vitest-environment happy-dom
//
// The live games list before it has any games: waiting for the lobby that
// sends them, or saying why a client without one never will.

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { en } from "../../../i18n/catalog/en";
import { failOnConsoleError } from "../../../testing/consoleGuard";
import { seedStore } from "../../../testing/mounted";
import { LiveReplayView } from "./LiveReplayView";

vi.mock("../../../ipc/client");

failOnConsoleError();

describe("LiveReplayView without a lobby connection, mounted", () => {
  it("waits for the lobby while it is connecting", () => {
    seedStore((state) => ({ ...state, lobby: { ...state.lobby, status: "connecting" } }));
    render(<LiveReplayView busy={false} />);
    expect(screen.getByText(en["replays.live.connecting"])).toBeDefined();
  });

  it("says why in a client without a lobby, rather than wait for one", () => {
    seedStore((state) => ({
      ...state,
      lobby: { ...state.lobby, status: "disconnected", unavailable: "notInAndroidClient" },
    }));
    render(<LiveReplayView busy={false} />);
    expect(screen.getByText(en["lobby.browser.unavailable"])).toBeDefined();
    expect(screen.getByText(en["lobby.unavailable.notInAndroidClient"])).toBeDefined();
    expect(screen.queryByText(en["replays.live.connecting"])).toBeNull();
  });
});
