import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GamePreparationStatus, ReplayDownloadTask } from "./ClientStatusBar";

describe("GamePreparationStatus", () => {
  it("shows measured launch preparation in the compact status-bar task", () => {
    const markup = renderToStaticMarkup(
      <GamePreparationStatus
        state={{
          type: "preparing",
          payload: { detail: "Updating faf 3836: units.nx2 (10/19)", progress: 47 },
        }}
      />,
    );

    expect(markup).toContain("Match setup:");
    expect(markup).toContain("Updating faf 3836: units.nx2 (10/19)");
    expect(markup).toContain('aria-valuenow="47"');
    expect(markup).toContain('style="width:47%"');
    expect(markup).toContain("47%");
  });

  it("keeps phases without a percentage explicitly indeterminate", () => {
    const markup = renderToStaticMarkup(
      <GamePreparationStatus
        state={{
          type: "preparing",
          payload: { detail: "Downloading map", progress: null },
        }}
      />,
    );

    expect(markup).toContain('data-indeterminate="true"');
    expect(markup).not.toContain("aria-valuenow");
    expect(markup).toContain("Active");
  });
});

describe("ReplayDownloadTask", () => {
  it("uses the shared bottom task slot while a replay is downloading", () => {
    const markup = renderToStaticMarkup(
      <ReplayDownloadTask status={{ type: "downloading", payload: { uid: 27456965 } }} />,
    );

    // The id never stands alone: the line names what it is, not just a number.
    expect(markup).toContain("Downloading:");
    expect(markup).toContain("Replay 27456965");
    expect(markup).toContain('data-indeterminate="true"');
    expect(markup).toContain("Active");
  });
});
