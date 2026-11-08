// @vitest-environment happy-dom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { InstallState, ResolvedPaths } from "../../ipc/bindings";
import { InstallBanner } from "./InstallBanner";
import { useAppStore } from "../../store/store";
import { applyEvent, seedStore, sentCommands } from "../../testing/mounted";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";

const shell = vi.hoisted(() => ({ selectFile: vi.fn() }));
vi.mock("../../ipc/native", () => ({ native: shell }));
vi.mock("../../ipc/client");
failOnConsoleError();

const GAME = "D:/Games/Supreme Commander Forged Alliance";

function seed(install: Partial<InstallState>, originalGameDir: string) {
  seedStore((state) => ({
    ...state,
    install: {
      ...state.install,
      checked: true,
      ...install,
      resolved: { ...state.install.resolved, originalGameDir },
    },
  }));
}

/** The install slice the backend sends after the paths were checked again. */
function checked(resolved: Partial<ResolvedPaths>) {
  const install = useAppStore.getState().state.install;
  applyEvent({
    kind: "Install",
    event: { ...install, resolved: { ...install.resolved, ...resolved } },
  });
}

it("says the original game is missing and picks its folder like Settings, Paths", async () => {
  seed({ gameReady: true }, "");
  shell.selectFile.mockResolvedValue(GAME);
  render(<InstallBanner />);

  expect(screen.getByText(en["shell.install.originalMissing"])).toBeTruthy();
  expect(screen.getByText(en["shell.install.originalMissingHint"])).toBeTruthy();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: en["shell.install.chooseOriginal"] }));

  expect(shell.selectFile).toHaveBeenCalledWith(
    expect.objectContaining({ directory: true, title: en["settings.paths.originalGamePickTitle"] }),
  );
  await waitFor(() =>
    expect(sentCommands()).toEqual([
      {
        kind: "Settings",
        command: { type: "patchPaths", payload: { patch: { originalGameDir: GAME } } },
      },
    ]),
  );

  // The check that follows the change finds the game, and the banner goes.
  checked({ originalGameDir: GAME });
  expect(screen.queryByText(en["shell.install.originalMissing"])).toBeNull();
});

it("also warns while FAF's own copy is still to be downloaded", () => {
  // A fresh machine: FAF's files come on their own, the original game does not.
  seed({ gameReady: false, gamePending: true }, "");
  render(<InstallBanner />);
  expect(screen.getByText(en["shell.install.originalMissing"])).toBeTruthy();
  expect(screen.queryByText(en["shell.install.notDownloadedYet"])).toBeNull();
});

it("keeps the missing FAF install first, and stays quiet when both are there", () => {
  seed({ gameReady: false, gamePending: false, replayReady: false }, "");
  const { unmount } = render(<InstallBanner />);
  expect(screen.getByText(en["shell.install.notFound"])).toBeTruthy();
  expect(screen.queryByText(en["shell.install.originalMissing"])).toBeNull();
  unmount();

  seed({ gameReady: true }, GAME);
  const { container } = render(<InstallBanner />);
  expect(container.innerHTML).toBe("");
});

it("says nothing before the first check", () => {
  seed({ checked: false, gameReady: false }, "");
  const { container } = render(<InstallBanner />);
  expect(container.innerHTML).toBe("");
});

it("can be dismissed, and Check again asks the backend to look again", async () => {
  seed({ gameReady: true }, "");
  render(<InstallBanner />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: en["shell.install.checkAgain"] }));
  expect(sentCommands()).toEqual([{ kind: "Settings", command: { type: "checkInstalls" } }]);
  await user.click(screen.getByRole("button", { name: en["shell.install.dismiss"] }));
  expect(screen.queryByText(en["shell.install.originalMissing"])).toBeNull();
});
