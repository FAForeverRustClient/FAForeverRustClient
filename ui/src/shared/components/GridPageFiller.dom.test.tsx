// @vitest-environment happy-dom
//
// The empty places that hold a short page of a card grid at a full page's
// height: a card's size, and otherwise absent.

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { failOnConsoleError } from "../../testing/consoleGuard";
import "../../testing/mounted";
import { GridPageFiller } from "./GridPageFiller";

vi.mock("../../ipc/client");

failOnConsoleError();

describe("a short page's empty places", () => {
  it("take a card's classes and are hidden from everyone", () => {
    const { container } = render(<GridPageFiller count={3} cardClassName="installed-map-card surface-panel" />);
    const cells = [...container.querySelectorAll(".grid-page-filler")];
    expect(cells).toHaveLength(3);
    for (const cell of cells) {
      expect(cell.classList.contains("installed-map-card")).toBe(true);
      expect(cell.classList.contains("surface-panel")).toBe(true);
      expect(cell.getAttribute("aria-hidden")).toBe("true");
      expect(cell.textContent).toBe("");
      // Nothing in one can take focus.
      expect(cell.querySelector("button, a, input, [tabindex]")).toBeNull();
    }
  });

  it("draw nothing when the page is full", () => {
    const { container } = render(<GridPageFiller count={0} cardClassName="installed-map-card" />);
    expect(container.childElementCount).toBe(0);
  });
});
