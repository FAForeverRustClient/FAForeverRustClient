// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { sentCommands } from "../../testing/mounted";
import { ipc } from "../../ipc/client";
import { BackgroundActivityTask } from "./ClientStatusBar";

vi.mock("../../ipc/client");
failOnConsoleError();

it("cancels the named catalogue without cancelling another background task", async () => {
  const user = userEvent.setup();
  render(<BackgroundActivityTask activities={[
    { id: "map-vault", label: "Map catalogue: 2 / 5 pages", progress: 40, cancel: () => ipc.send({ kind: "Maps", command: { type: "cancelVaultLoad" } }) },
    { id: "mod-vault", label: "Mod catalogue", progress: null, cancel: () => ipc.send({ kind: "Mods", command: { type: "cancelVaultLoad" } }) },
  ]} />);
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
  await user.click(screen.getByRole("button", { name: "Cancel: Map catalogue: 2 / 5 pages" }));
  expect(sentCommands()).toEqual([{ kind: "Maps", command: { type: "cancelVaultLoad" } }]);
});

it("keeps a catalogue's page count and percent out of what the live slot reads out", () => {
  // The slot is a live region: a count in it was read out on every page.
  render(<BackgroundActivityTask activities={[
    { id: "map-vault", label: "Map catalogue: 2 / 5 pages", name: "Map catalogue", progress: 40 },
  ]} />);
  const label = document.querySelector(".client-status-task-label");
  expect(label?.textContent).toBe("Map catalogue: 2 / 5 pages");
  expect(label?.querySelector('[aria-hidden="true"]')?.textContent).toBe(": 2 / 5 pages");
  expect(document.querySelector(".client-status-task-percent")?.getAttribute("aria-hidden")).toBe("true");
  expect(screen.getByRole("progressbar").getAttribute("aria-valuetext")).toBe("40%");
});
