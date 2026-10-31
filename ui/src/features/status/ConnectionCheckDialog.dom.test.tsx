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
    const menu = screen.getByRole("menu", { name: "FAF connection status" });
    // The state heads the menu as text; only what can be done is an item.
    expect(within(menu).getByText("connected").closest("button")).toBeNull();
    expect(within(menu).getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Disconnect", "Check connection"]);
    await user.click(screen.getByRole("menuitem", { name: "Check connection" }));
    const dialog = screen.getByRole("dialog", { name: "Connection check" });
    expect(dialog.classList.contains("has-live")).toBe(false);
    expect(within(dialog).getByRole("region", { name: "Live connections" }).textContent)
      .toContain("During a game, the players and how each one is connected are listed here.");
    // The dialog's title already says what this is; no second heading repeats it.
    expect(within(dialog).queryByRole("heading", { name: "Connectivity check" })).toBeNull();
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
    expect(within(row).queryByText(path)).toBeNull();
    const toggle = within(row).getByRole("button", { name: "Show path" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    await user.click(toggle);
    const shown = within(row).getByText(path);
    expect(shown.tagName).toBe("CODE");
    const hide = within(row).getByRole("button", { name: "Hide path" });
    expect(hide.getAttribute("aria-expanded")).toBe("true");
    expect(hide.getAttribute("aria-controls")).toBe(shown.id);
    await user.click(hide);
    expect(within(row).queryByText(path)).toBeNull();
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
