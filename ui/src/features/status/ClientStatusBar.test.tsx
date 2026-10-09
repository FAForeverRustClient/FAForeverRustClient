import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BackgroundActivityTask, GamePreparationStatus } from "./ClientStatusBar";

describe("GamePreparationStatus", () => {
  it("shows measured launch preparation in the compact status-bar task", () => {
    const markup = renderToStaticMarkup(
      <GamePreparationStatus
        state={{
          type: "preparing",
          payload: {
            phase: "downloading",
            detail: "Updating faf 3836: units.nx2 (10/19)",
            progress: 47,
          },
        }}
      />,
    );

    expect(markup).toContain("Match setup:");
    expect(markup).toContain("Updating faf 3836: units.nx2 (10/19)");
    expect(markup).toContain('aria-valuenow="47"');
    expect(markup).toContain('style="width:47%"');
    expect(markup).toContain("47%");
    // The dialog can be hidden for a long patch, so the line carries its Cancel.
    expect(markup).toContain('aria-label="Cancel joining"');
  });

  it("keeps phases without a percentage explicitly indeterminate", () => {
    const markup = renderToStaticMarkup(
      <GamePreparationStatus
        state={{
          type: "preparing",
          payload: { phase: "map", detail: "Downloading map", progress: null },
        }}
      />,
    );

    expect(markup).toContain('data-indeterminate="true"');
    expect(markup).not.toContain("aria-valuenow");
    expect(markup).toContain("Active");
  });
});

describe("BackgroundActivityTask", () => {
  it("names the replay it downloads and sweeps while the size is unknown", () => {
    const markup = renderToStaticMarkup(
      <BackgroundActivityTask
        activities={[{ id: "replay-download", label: "Downloading replay 27456965", progress: null }]}
      />,
    );

    // The id never stands alone: the line names what it is, not just a number.
    expect(markup).toContain("Downloading replay 27456965");
    expect(markup).toContain('data-indeterminate="true"');
    expect(markup).toContain("Active");
    expect(markup).not.toContain("<button");
  });
});
