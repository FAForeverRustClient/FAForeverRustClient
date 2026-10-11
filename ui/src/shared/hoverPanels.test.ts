import { describe, expect, it, vi } from "vitest";
import { noteHoverPanelClosed, noteHoverPanelOpen } from "./hoverPanels";

describe("hover panels", () => {
  it("closes the previous game card when the next one opens", () => {
    const closeFirst = vi.fn(() => noteHoverPanelClosed("first"));
    const closeSecond = vi.fn(() => noteHoverPanelClosed("second"));

    noteHoverPanelOpen("first", closeFirst);
    noteHoverPanelOpen("second", closeSecond);

    expect(closeFirst).toHaveBeenCalledTimes(1);
    expect(closeSecond).not.toHaveBeenCalled();
    noteHoverPanelClosed("second");
  });

  it("leaves panels without a closer out of it, both ways", () => {
    const closeCard = vi.fn(() => noteHoverPanelClosed("card"));

    noteHoverPanelOpen("card", closeCard);
    // The rating card: opening it must not shut the game card it sits under.
    noteHoverPanelOpen("rating");
    expect(closeCard).not.toHaveBeenCalled();

    // And a game card opening leaves the rating card to close on its own.
    const closeOther = vi.fn(() => noteHoverPanelClosed("other"));
    noteHoverPanelOpen("other", closeOther);
    expect(closeCard).toHaveBeenCalledTimes(1);
    expect(closeOther).not.toHaveBeenCalled();

    noteHoverPanelClosed("rating");
    noteHoverPanelClosed("other");
  });

  it("does not close a card that opens again over itself", () => {
    const close = vi.fn(() => noteHoverPanelClosed("same"));

    noteHoverPanelOpen("same", close);
    noteHoverPanelOpen("same", close);

    expect(close).not.toHaveBeenCalled();
    noteHoverPanelClosed("same");
  });
});
