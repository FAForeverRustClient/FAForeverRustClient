// @vitest-environment happy-dom
//
// A map generator run that failed, in the Generate Map dialog that started it.
// The dialog used to say nothing at all: its progress line is only drawn while
// a run is busy, so a failure dropped it back to the empty preview. It now
// says the failure plainly, keeps the generator's own words on hover, and
// Retry sends the run that failed again. A failure from a run started
// somewhere else is not this dialog's to report.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppCommand, GeneratorStatus } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, seedStore, sentCommands } from "../../testing/mounted";
import { GenerateMapModal } from "./GenerateMapModal";

vi.mock("../../ipc/client");

failOnConsoleError();

const generatorStatus = (status: GeneratorStatus) =>
  applyEvent({ kind: "MapGenerator", event: { type: "statusChanged", payload: { status } } });

/** The generator commands of one type sent since the last clear. */
function sentGenerator(type: string): AppCommand[] {
  return sentCommands().filter((command) => command.kind === "MapGenerator" && command.command.type === type);
}

/** The dialog as it opens, with the reads it sent on opening set aside. */
function mountDialog() {
  render(<GenerateMapModal onClose={() => undefined} />);
  clearSentCommands();
}

const failedDownload =
  "error sending request for url (https://github.com/FAForever/Neroxis-Map-Generator/releases/download/1.12.0/NeroxisGen_1.12.0.jar)";

describe("Generate Map dialog, a failed run, mounted", () => {
  it("says its own run's failure plainly, with the generator's words on hover, and runs it again from Retry", async () => {
    const user = userEvent.setup();
    mountDialog();

    await user.click(screen.getByRole("button", { name: en["maps.generate.generate"] }));
    const run = sentGenerator("generate");
    expect(run).toHaveLength(1);

    generatorStatus({ type: "preparing" });
    generatorStatus({ type: "downloading", payload: { version: "1.12.0", downloadedBytes: 0, totalBytes: null } });
    expect(screen.queryByRole("alert")).toBeNull();
    generatorStatus({ type: "failed", payload: { reason: failedDownload } });

    const alert = screen.getByRole("alert");
    const sentence = en["replays.detail.generationFailed"].replace("{error}", en["errors.cause.offline"]);
    expect(within(alert).getByText(sentence).getAttribute("title")).toBe(failedDownload);
    expect(alert.textContent).not.toContain("error sending request");

    clearSentCommands();
    await user.click(within(alert).getByRole("button", { name: en["common.retry"] }));
    expect(sentGenerator("generate")).toEqual(run);
    // The new attempt takes the old failure down at once.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not report a failure from a run it did not start", () => {
    seedStore((state) => ({
      ...state,
      mapGenerator: { ...state.mapGenerator, status: { type: "failed", payload: { reason: failedDownload } } },
    }));
    mountDialog();
    expect(screen.queryByRole("alert")).toBeNull();

    // Nor one that lands while it is open, from a replay's details, say.
    generatorStatus({ type: "preparing" });
    generatorStatus({ type: "failed", payload: { reason: "the generator exited with code 1" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
