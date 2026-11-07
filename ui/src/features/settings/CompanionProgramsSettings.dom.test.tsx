// @vitest-environment happy-dom

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { AppCommand, CompanionProgram, CompanionRun } from "../../ipc/bindings";
import { CompanionProgramsSettings } from "./CompanionProgramsSettings";
import { seedStore, sentCommands } from "../../testing/mounted";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";

const shell = vi.hoisted(() => ({ selectFile: vi.fn(), selectDirectory: vi.fn() }));
vi.mock("../../ipc/native", () => ({ native: shell }));
vi.mock("../../ipc/client");
failOnConsoleError();

const helper: CompanionProgram = {
  id: "helper",
  enabled: true,
  name: "Helper",
  program: "C:/Tools/helper.exe",
  arguments: "\"C:/Settings/helper.ini\"",
  workingDir: "",
  launches: "games",
  timing: "after",
  closeWithGame: false,
  skipIfRunning: "",
};

function seed(companions: CompanionProgram[], runs: CompanionRun[] = []) {
  seedStore((state) => ({
    ...state,
    settings: { ...state.settings, game: { ...state.settings.game, companions } },
    install: { ...state.install, companions: runs },
  }));
}

/** The settings commands the block sent, in order, without the `Settings` wrapper. */
const settingsCommands = () =>
  sentCommands().flatMap((command: AppCommand) => (command.kind === "Settings" ? [command.command] : []));

/** One field patch for the entry this file seeds. */
const patched = (patch: object, base: object | null = null) => ({ type: "patchCompanion", payload: { id: "helper", base, patch } });

/** What the seeded entry runs, which a text save names as its base. */
const storedCommand = { program: helper.program, arguments: helper.arguments, workingDir: helper.workingDir };

const typedDraft = (changes: object) => ({
  name: helper.name,
  program: helper.program,
  arguments: helper.arguments,
  workingDir: helper.workingDir,
  skipIfRunning: helper.skipIfRunning,
  ...changes,
});

it("adds an entry with an id of its own that runs nothing yet, leaving the rest alone", async () => {
  seed([helper]);
  render(<CompanionProgramsSettings />);
  await userEvent.setup().click(screen.getByRole("button", { name: en["settings.game.companions.add"] }));
  const [added] = settingsCommands();
  expect(added.type).toBe("addCompanion");
  const companion = added.type === "addCompanion" ? added.payload.companion : {};
  expect(companion.id).toBeTruthy();
  expect(companion.id).not.toBe("helper");
  expect(companion.program ?? "").toBe("");
});

it("saves the text fields together, and only on Save", async () => {
  seed([helper]);
  render(<CompanionProgramsSettings />);
  const user = userEvent.setup();
  const program = screen.getByDisplayValue(helper.program!);
  await user.clear(program);
  await user.type(program, "C:/Tools/obs64.exe");
  await user.tab();
  // Leaving the field asks nothing: one change, one confirmation.
  expect(settingsCommands()).toHaveLength(0);

  await user.click(screen.getByRole("button", { name: en["settings.game.companions.save"] }));
  expect(settingsCommands()).toEqual([patched(typedDraft({ program: "C:/Tools/obs64.exe" }), storedCommand)]);
});

it("saves what is being typed before a test start, so it starts what is shown", async () => {
  seed([helper]);
  render(<CompanionProgramsSettings />);
  const user = userEvent.setup();
  await user.type(screen.getByDisplayValue(helper.arguments!), " /fast");
  await user.click(screen.getByRole("button", { name: en["settings.game.companions.test"] }));
  await waitFor(() => expect(settingsCommands()).toHaveLength(2));
  expect(settingsCommands()).toEqual([
    patched(typedDraft({ arguments: `${helper.arguments!} /fast` }), storedCommand),
    { type: "testCompanion", payload: { id: "helper", expected: { ...storedCommand, arguments: `${helper.arguments!} /fast` } } },
  ]);
});

it("saves a switch at once as that one field, keeping the draft being typed", async () => {
  seed([helper]);
  render(<CompanionProgramsSettings />);
  const user = userEvent.setup();
  await user.type(screen.getByDisplayValue(helper.arguments!), " /fast");
  await user.click(screen.getByRole("checkbox", { name: en["settings.game.companions.closeWithGame"] }));
  await user.click(screen.getByRole("checkbox", { name: en["settings.game.companions.enabled"].replace("{name}", "Helper") }));
  // Each carries its own field only, so the second cannot undo the first.
  expect(settingsCommands()).toEqual([patched({ closeWithGame: true }), patched({ enabled: false })]);
  expect(screen.getByDisplayValue(`${helper.arguments!} /fast`)).toBeTruthy();
});

it("removes the entry by id", async () => {
  seed([helper]);
  render(<CompanionProgramsSettings />);
  await userEvent.setup().click(screen.getByRole("button", { name: en["settings.game.companions.remove"] }));
  expect(settingsCommands()).toEqual([{ type: "removeCompanion", payload: { id: "helper" } }]);
});

it("starts the stored entry by id and shows what the last start came to", async () => {
  seed([helper], [{ id: "helper", name: "Helper", outcome: { type: "failed", payload: { reason: "the program was not found" } }, at: 1_700_000_000 }]);
  render(<CompanionProgramsSettings />);
  expect(screen.getByRole("status").textContent).toContain("the program was not found");
  await userEvent.setup().click(screen.getByRole("button", { name: en["settings.game.companions.test"] }));
  await waitFor(() =>
    expect(sentCommands()).toEqual([
      { kind: "Settings", command: { type: "testCompanion", payload: { id: "helper", expected: storedCommand } } },
    ]),
  );
});

it("says when an entry has not been started yet", () => {
  seed([helper]);
  render(<CompanionProgramsSettings />);
  expect(screen.getByRole("status").textContent).toBe(en["settings.game.companions.neverStarted"]);
});
