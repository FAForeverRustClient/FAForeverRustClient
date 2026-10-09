// @vitest-environment happy-dom
//
// Settings rows that ask the shell for something (open a folder, read the
// newest log) and are refused. The shell's message is half the operating
// system's language and half a path ("could not open C:\...\logs: Zugriff
// verweigert (os error 5)"); each row says it plainly now, keeps the message
// on hover, and Retry asks for the same thing again.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import "../../testing/mounted";
import { DiagnosticsSettingsSection } from "./DiagnosticsSettingsSection";
import { FoldersSettingsSection } from "./FoldersSettingsSection";

/** The shell calls these rows make, in place of the Tauri bridge. */
const shell = vi.hoisted(() => ({
  openLogFolder: vi.fn<(kind: string) => Promise<void>>(),
  openClientFolder: vi.fn<(kind: string) => Promise<void>>(),
  readLatestLog: vi.fn<(kind: string) => Promise<unknown>>(),
}));

vi.mock("../../ipc/client");
vi.mock("../../ipc/native", () => ({ native: shell }));

failOnConsoleError();

const DENIED = "could not open C:\\Users\\Nory\\AppData\\Roaming\\faf\\logs: Zugriff verweigert (os error 5)";

beforeEach(() => {
  shell.openLogFolder.mockReset();
  shell.openClientFolder.mockReset();
  shell.readLatestLog.mockReset();
});

describe("a refused folder, mounted", () => {
  it("says a log folder that would not open plainly, and opens the same one again from Retry", async () => {
    const user = userEvent.setup();
    shell.openLogFolder.mockRejectedValueOnce(DENIED).mockResolvedValueOnce(undefined);
    render(<DiagnosticsSettingsSection />);

    // The game logs' row is the first of the two.
    await user.click(screen.getAllByRole("button", { name: en["settings.diagnostics.openFolder"] })[0]);

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en["errors.cause.locked"]).getAttribute("title")).toBe(DENIED);
    expect(alert.textContent).not.toContain("os error");

    await user.click(within(alert).getByRole("button", { name: en["common.retry"] }));
    expect(shell.openLogFolder.mock.calls).toEqual([["game"], ["game"]]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("retries reading the newest log, not opening its folder, when that is what failed", async () => {
    const user = userEvent.setup();
    shell.readLatestLog.mockRejectedValue("could not read latest log: The process cannot access the file (os error 32)");
    render(<DiagnosticsSettingsSection />);

    // The client logs' row is the second.
    await user.click(screen.getAllByRole("button", { name: en["settings.diagnostics.viewLatest"] })[1]);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en["errors.cause.inUse"])).toBeTruthy();

    await user.click(within(alert).getByRole("button", { name: en["common.retry"] }));
    expect(shell.readLatestLog.mock.calls).toEqual([["client"], ["client"]]);
    expect(shell.openLogFolder).not.toHaveBeenCalled();
  });

  it("says a client folder that would not open plainly, and opens the same one again from Retry", async () => {
    const user = userEvent.setup();
    const reason = "could not create D:\\Games\\FAF\\maps: Das System kann den angegebenen Pfad nicht finden. (os error 3)";
    shell.openClientFolder.mockRejectedValue(reason);
    render(<FoldersSettingsSection />);

    await user.click(screen.getByRole("button", { name: en["settings.folders.maps"] }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(en["errors.cause.missing"]).getAttribute("title")).toBe(reason);

    await user.click(within(alert).getByRole("button", { name: en["common.retry"] }));
    expect(shell.openClientFolder.mock.calls).toEqual([["maps"], ["maps"]]);
  });
});
