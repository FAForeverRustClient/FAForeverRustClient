// @vitest-environment happy-dom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { useAppStore } from "../../store/store";
import { ClientStatusBar } from "./ClientStatusBar";
import { ConnectionCheckDialog } from "./ConnectionCheckDialog";

vi.mock("../../ipc/client");
failOnConsoleError();
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("the connection check dialog", () => {
  it("opens from the status popup, starts a check and keeps the idle live view compact", async () => {
    const user = userEvent.setup();
    seedStore((state) => ({ ...state, lobby: { ...state.lobby, status: "connected" } }));
    render(<ClientStatusBar />);
    await user.click(screen.getByRole("button", { name: /^FAF / }));
    expect(screen.getByRole("menuitem", { name: "Disconnect" })).toBeTruthy();
    await user.click(screen.getByRole("menuitem", { name: "Check connection" }));
    const dialog = screen.getByRole("dialog", { name: "Connection check" });
    expect(dialog.classList.contains("has-live")).toBe(false);
    expect(within(dialog).getByRole("region", { name: "Live connections" }).textContent).toContain("No game is running.");
    expect(sentCommands()).toContainEqual({ kind: "Connectivity", command: { type: "runCheck" } });
    expect(sentCommands()).not.toContainEqual({ kind: "Connectivity", command: { type: "refreshRelayStatus" } });
  });

  it("keeps successful runtime information short and makes its full path expandable", async () => {
    const user = userEvent.setup();
    const path = "C:/tools/runtime/bin/java.exe";
    seedStore((state) => ({ ...state, connectivity: { ...state.connectivity, check: {
      status: { type: "finished", payload: { verdict: "warn" } },
      startedAt: "2026-10-31T10:00:00Z",
      steps: [{ id: "javaRuntime", outcome: "pass", finding: { type: "javaRuntime", payload: { version: "25.0.3", path } } }],
    } } }));
    render(<ConnectionCheckDialog onClose={vi.fn()} />);
    expect(screen.getByText("Check completed with warnings.")).toBeTruthy();
    const row = screen.getByText("Java runtime").closest("li");
    if (!row) throw new Error("No runtime result");
    expect(within(row).getByText("Java 25.0.3, at java.exe.")).toBeTruthy();
    const details = row.querySelector("details");
    expect(details?.open).toBe(false);
    expect(within(row).getByText(path).tagName).toBe("CODE");
    await user.tab();
    expect(document.activeElement).toBe(within(row).getByText("Show installation path"));
    await user.click(within(row).getByText("Show installation path"));
    expect(details?.open).toBe(true);
    expect(within(row).getByText(path).textContent).toBe(path);
  });

  it("adds the live column and polls only while a game runs and the dialog is mounted", () => {
    vi.useFakeTimers();
    const view = render(<ConnectionCheckDialog onClose={vi.fn()} />);
    clearSentCommands();
    act(() => {
      const current = useAppStore.getState().state;
      useAppStore.getState().hydrate({ ...current, lobby: { ...current.lobby, join: { type: "inGame" } } });
    });
    expect(screen.getByRole("dialog", { name: "Connection check" }).classList.contains("has-live")).toBe(true);
    expect(screen.queryByText("No game is running.")).toBeNull();
    expect(sentCommands()).toEqual([{ kind: "Connectivity", command: { type: "refreshRelayStatus" } }]);
    clearSentCommands();
    view.unmount();
    act(() => { vi.advanceTimersByTime(4000); });
    expect(sentCommands()).toEqual([]);
  });
});
