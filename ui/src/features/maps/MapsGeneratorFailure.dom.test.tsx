// @vitest-environment happy-dom
//
// The Maps tab, where a map generator run's outcome lands. Its status line was
// only drawn while a run was busy, so a run that failed after the Generate Map
// dialog was closed left the tab saying nothing at all. The failure now stays
// until it is dismissed or the next run begins: plainly, with the generator's
// own words on hover, and with Retry when the run was sent from this client
// and nothing else has begun since. A failed hide or unhide in the vault is
// worded the same way.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppCommand, GeneratorStatus } from "../../ipc/bindings";
import { en } from "../../i18n/catalog/en";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { applyEvent, clearSentCommands, initialState, sentCommands } from "../../testing/mounted";
import { generate } from "./generatorCommands";
import { MapsView } from "./MapsView";

vi.mock("../../ipc/client");

failOnConsoleError();

const generatorStatus = (status: GeneratorStatus) =>
  applyEvent({ kind: "MapGenerator", event: { type: "statusChanged", payload: { status } } });

/** The generator runs sent since the last clear. */
function runs(): AppCommand[] {
  return sentCommands().filter(
    (command) =>
      command.kind === "MapGenerator" &&
      (command.command.type === "generate" || command.command.type === "generateNamed"),
  );
}

/** The tab as it opens, with the reads it sent on opening set aside. */
function mountMaps() {
  render(<MapsView />);
  clearSentCommands();
}

const failedDownload =
  "error sending request for url (https://github.com/FAForever/Neroxis-Map-Generator/releases/download/1.12.0/NeroxisGen_1.12.0.jar)";

describe("Maps tab, a generator run that failed", () => {
  it("says the failure of a run sent from the closed dialog plainly, and runs it again from Retry", async () => {
    const user = userEvent.setup();
    // What the dialog sends, before it is closed.
    generate(initialState().mapGenerator.options);
    const run = runs();
    expect(run).toHaveLength(1);
    mountMaps();

    generatorStatus({ type: "preparing" });
    generatorStatus({ type: "downloading", payload: { version: "1.12.0", downloadedBytes: 0, totalBytes: null } });
    expect(screen.queryByRole("alert")).toBeNull();
    generatorStatus({ type: "failed", payload: { reason: failedDownload } });

    const alert = screen.getByRole("alert");
    const sentence = en["replays.detail.generationFailed"].replace("{error}", en["errors.cause.offline"]);
    expect(within(alert).getByText(sentence).getAttribute("title")).toBe(failedDownload);
    expect(alert.textContent).not.toContain("error sending request");

    await user.click(within(alert).getByRole("button", { name: en["common.retry"] }));
    expect(runs()).toEqual(run);

    // The next run takes the failure down as it begins.
    generatorStatus({ type: "preparing" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers no Retry for a run started elsewhere since, and can be dismissed until the next failure", async () => {
    const user = userEvent.setup();
    generate(initialState().mapGenerator.options);
    mountMaps();
    generatorStatus({ type: "preparing" });
    generatorStatus({ type: "generated", payload: { maps: ["neroxis_map_generator_1.12.0_aaaa"] } });

    // A replay's details reproduce their map; that run was not sent from here,
    // so what to send again is not known.
    generatorStatus({ type: "resolvingVersion" });
    generatorStatus({ type: "failed", payload: { reason: "the generator exited with code 1" } });

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(/The generator exited with code 1\./).getAttribute("title"))
      .toBe("the generator exited with code 1");
    expect(within(alert).queryByRole("button", { name: en["common.retry"] })).toBeNull();

    await user.click(within(alert).getByRole("button", { name: en["common.dismiss"] }));
    expect(screen.queryByRole("alert")).toBeNull();

    // The next failure is a new one, and is shown again.
    generatorStatus({ type: "generating", payload: { version: "1.12.0", detail: "placing mexes" } });
    generatorStatus({ type: "failed", payload: { reason: "the generator exited with code 1" } });
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("words a failed unhide plainly, keeps the reason on hover, and can be dismissed", async () => {
    const user = userEvent.setup();
    mountMaps();
    const reason = "FAF refused the change: error sending request for url (https://api.faforever.com/data/mapVersion/9)";
    applyEvent({ kind: "Maps", event: { type: "mapVisibilityFailed", payload: { reason } } });

    const alert = screen.getByRole("alert");
    expect(within(alert).getByText(en["errors.cause.offline"]).getAttribute("title")).toBe(reason);
    await user.click(within(alert).getByRole("button", { name: en["common.dismiss"] }));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
