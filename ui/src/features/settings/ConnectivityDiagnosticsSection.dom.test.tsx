// @vitest-environment happy-dom
//
// The connectivity check under Settings > Connectivity, mounted against the
// store: the button sends the command, the backend's lines render with their
// outcome as each arrives, a failed line says what failed, and the live relay
// view asks the adapter only while a game runs and this page is open.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CheckStep } from "../../ipc/bindings";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, seedStore, sentCommands } from "../../testing/mounted";
import { ConnectivityDiagnosticsSection } from "./ConnectivityDiagnosticsSection";

vi.mock("../../ipc/client");

failOnConsoleError();

function report(step: CheckStep): void {
  applyEvent({ kind: "Connectivity", event: { type: "stepReported", payload: { step } } });
}

function startCheck(): void {
  applyEvent({
    kind: "Connectivity",
    event: { type: "checkStarted", payload: { startedAt: "2026-10-08T18:00:00+00:00" } },
  });
}

/** The list item a line's title is in. */
function lineOf(title: string): HTMLElement {
  const item = screen.getByText(title).closest("li");
  if (!item) throw new Error(`no line titled ${title}`);
  return item;
}

describe("ConnectivityDiagnosticsSection", () => {
  it("sends the check when Run check is pressed", async () => {
    const user = userEvent.setup();
    render(<ConnectivityDiagnosticsSection />);

    await user.click(screen.getByRole("button", { name: "Run check" }));

    expect(sentCommands()).toEqual([{ kind: "Connectivity", command: { type: "runCheck" } }]);
  });

  it("renders each line with its outcome as the backend reports it", () => {
    render(<ConnectivityDiagnosticsSection />);
    startCheck();

    // While it runs, the button says so and cannot be pressed twice.
    expect(screen.getByRole("button", { name: "Checking…" })).toHaveProperty("disabled", true);

    report({
      id: "selection",
      outcome: "info",
      finding: { type: "adapterSelection", payload: { join: "dynamic", host: "java", forced: null } },
    });
    report({
      id: "server:0",
      outcome: "running",
      finding: { type: "serverProbing", payload: { url: "stun:eu.relay.example.org", transport: "udp" } },
    });
    expect(within(lineOf("stun:eu.relay.example.org")).getByRole("img", { name: "Checking" })).toBeTruthy();

    report({
      id: "server:0",
      outcome: "pass",
      finding: {
        type: "serverReachable",
        payload: {
          url: "stun:eu.relay.example.org",
          transport: "udp",
          roundTripMs: 23,
          publicAddress: "203.0.113.7:51234",
        },
      },
    });
    report({
      id: "relayList",
      outcome: "warn",
      finding: { type: "relayListNeedsSignIn" },
    });
    applyEvent({ kind: "Connectivity", event: { type: "checkFinished", payload: { verdict: "warn" } } });

    const server = lineOf("stun:eu.relay.example.org");
    expect(within(server).getByRole("img", { name: "Passed" })).toBeTruthy();
    expect(within(server).getByText("Answered over UDP in 23 ms. It sees you at 203.0.113.7:51234.")).toBeTruthy();
    expect(screen.getAllByText("stun:eu.relay.example.org")).toHaveLength(1);

    expect(within(lineOf("Selected adapter")).getByText("Joining: Dynamic (follows the host). Hosting: Java.")).toBeTruthy();
    expect(within(lineOf("FAF relay list")).getByRole("img", { name: "Warning" })).toBeTruthy();
    expect(screen.getByText("Works, with warnings below.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run again" })).toHaveProperty("disabled", false);
  });

  it("says what a failed line failed on", () => {
    render(<ConnectivityDiagnosticsSection />);
    startCheck();
    report({
      id: "javaRuntime",
      outcome: "fail",
      finding: {
        type: "javaRuntimeMissing",
        payload: { path: "java", reason: "no Java runtime was found there" },
      },
    });
    report({
      id: "server:1",
      outcome: "warn",
      finding: {
        type: "serverUnreachable",
        payload: {
          url: "turn:us.relay.example.org?transport=tcp",
          transport: "tcp",
          failure: { type: "timeout", payload: { waitedMs: 3000 } },
        },
      },
    });
    report({
      id: "relayAddresses",
      outcome: "warn",
      finding: { type: "noRelayAddresses" },
    });
    applyEvent({ kind: "Connectivity", event: { type: "checkFinished", payload: { verdict: "fail" } } });

    const runtime = lineOf("Java runtime");
    expect(runtime.dataset.outcome).toBe("fail");
    expect(within(runtime).getByRole("img", { name: "Failed" })).toBeTruthy();
    expect(
      within(runtime).getByText(
        "Could not run java: no Java runtime was found there. The Java adapter cannot start without it.",
      ),
    ).toBeTruthy();
    expect(
      within(lineOf("turn:us.relay.example.org?transport=tcp")).getByText("No answer over TCP within 3 seconds."),
    ).toBeTruthy();
    // The limit of the check is said, not passed over.
    expect(within(lineOf("Relay addresses")).getByText(/only hands out relay addresses for a game/)).toBeTruthy();
    expect(screen.getByText("Problems found. The marked lines below say what failed.")).toBeTruthy();
  });

  it("keeps the adapter log folded until asked for", async () => {
    const user = userEvent.setup();
    render(<ConnectivityDiagnosticsSection />);
    startCheck();
    report({
      id: "adapterLog",
      outcome: "info",
      finding: {
        type: "adapterLog",
        payload: {
          fileName: "ice-adapter.log",
          modifiedAt: "2026-10-08T17:59:00+00:00",
          tail: "INFO ICE connected to peer 436001",
          truncated: true,
        },
      },
    });

    expect(screen.queryByText("INFO ICE connected to peer 436001")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show the last lines" }));
    expect(screen.getByLabelText("Contents of ice-adapter.log").textContent).toBe("INFO ICE connected to peer 436001");
    expect(screen.getByText("Only the newest lines are shown.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide the log" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("asks the adapter for its peers only while a game runs and the page is open", () => {
    seedStore((state) => ({
      ...state,
      nav: { ...state.nav, settingsSection: "connectivity" },
      lobby: { ...state.lobby, join: { type: "inGame" } },
    }));
    const { unmount } = render(<ConnectivityDiagnosticsSection />);

    expect(sentCommands()).toEqual([{ kind: "Connectivity", command: { type: "refreshRelayStatus" } }]);
    expect(screen.getByText("Asking the adapter…")).toBeTruthy();

    applyEvent({
      kind: "Connectivity",
      event: {
        type: "relayStatusUpdated",
        payload: {
          status: {
            type: "live",
            payload: {
              snapshot: {
                adapterVersion: "3.3.9",
                gameState: "Lobby",
                gameConnected: true,
                peers: [
                  {
                    playerId: 436001,
                    login: "Critren",
                    state: "connected",
                    connected: true,
                    localCandidate: "srflx",
                    remoteCandidate: "relay",
                  },
                  {
                    playerId: 9,
                    login: "",
                    state: "checking",
                    connected: false,
                    localCandidate: "",
                    remoteCandidate: "",
                  },
                ],
              },
            },
          },
        },
      },
    });

    const critren = screen.getByText("Critren").closest("tr");
    expect(critren).not.toBeNull();
    expect(within(critren as HTMLElement).getByText("Connected")).toBeTruthy();
    expect(within(critren as HTMLElement).getByText("Through a FAF relay")).toBeTruthy();
    const unnamed = screen.getByText("Player 9").closest("tr") as HTMLElement;
    expect(within(unnamed).getByText("Trying routes")).toBeTruthy();
    expect(within(unnamed).getByText("Not settled yet")).toBeTruthy();
    unmount();
  });

  it("does not poll when no game is running", () => {
    seedStore((state) => ({ ...state, nav: { ...state.nav, settingsSection: "connectivity" } }));
    render(<ConnectivityDiagnosticsSection />);
    expect(sentCommands()).toEqual([]);
    expect(screen.getByText("No game is running.")).toBeTruthy();
  });
});
