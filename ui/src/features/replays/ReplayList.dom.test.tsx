// @vitest-environment happy-dom
//
// The replay list's columns against their floors: a divider used to take any
// column down to a pixel, and the last one, Watch with Download and Mark
// watched beside it, then clipped all three with no way to scroll to them.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { failOnConsoleError } from "../../testing/consoleGuard";
import { seedStore } from "../../testing/mounted";
import { ReplayList } from "./ReplayList";

vi.mock("../../ipc/client");

failOnConsoleError();

/** The grid tracks the list draws, one per column in drawn order. */
function drawnColumns(container: HTMLElement): string[] {
  const section = container.querySelector<HTMLElement>("[style*='--replay-list-columns']");
  const template = section?.style.getPropertyValue("--replay-list-columns").trim() ?? "";
  return template.split(/\s+(?![^(]*\))/);
}

describe("ReplayList column floors", () => {
  it("draws every column at its floor however narrow it was dragged and saved", () => {
    seedStore((state) => ({
      ...state,
      settings: {
        ...state.settings,
        browsing: { ...state.settings.browsing, replayListColumns: [1, 1, 1, 1, 1, 1, 1, 1] },
      },
    }));
    const { container } = render(<ReplayList groups={[]} footer={<span>0 replays</span>} />);

    expect(drawnColumns(container)).toEqual([
      "44px", "minmax(120px, 1fr)", "56px", "64px", "40px", "48px", "56px", "140px",
    ]);
  });

  it("scrolls sideways instead of clipping when even the floors do not fit, at a 560 pixel window", () => {
    // About 400 pixels for the list. The game column used to collapse to
    // nothing and the actions fell outside the clipped list.
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(400);
    try {
      const { container } = render(<ReplayList groups={[]} footer={<span>0 replays</span>} />);
      const section = container.querySelector<HTMLElement>(".replay-list-wrap");

      expect(section?.classList.contains("has-column-overflow")).toBe(true);
      expect(drawnColumns(container)).toEqual([
        "44px", "minmax(120px, 1fr)", "56px", "64px", "40px", "48px", "56px", "140px",
      ]);
      // The floors, 568 pixels, plus the row's seven gaps and its padding.
      expect(section?.style.getPropertyValue("--replay-list-min-width").trim()).toBe(
        "calc(568px + 7 * var(--space-4) + 2 * var(--space-3))",
      );
    } finally {
      width.mockRestore();
    }
  });

  it("leaves a list that fits alone", () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1400);
    try {
      const { container } = render(<ReplayList groups={[]} footer={<span>0 replays</span>} />);
      const section = container.querySelector<HTMLElement>(".replay-list-wrap");

      expect(section?.classList.contains("has-column-overflow")).toBe(false);
      expect(section?.style.getPropertyValue("--replay-list-min-width")).toBe("");
    } finally {
      width.mockRestore();
    }
  });
});
