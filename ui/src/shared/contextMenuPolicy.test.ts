import { describe, expect, it, vi } from "vitest";
import { allowsEditingContextMenu, applyDesktopContextMenuPolicy } from "./contextMenuPolicy";

const targetWithClosestResult = (result: unknown): EventTarget => ({
  closest: vi.fn(() => result),
}) as unknown as EventTarget;

describe("desktop context-menu policy", () => {
  it("allows the native editing menu inside editable controls", () => {
    expect(allowsEditingContextMenu(targetWithClosestResult({}))).toBe(true);
  });

  it("suppresses the browser menu on application surfaces", () => {
    const preventDefault = vi.fn();
    applyDesktopContextMenuPolicy({
      target: targetWithClosestResult(null),
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it("does not suppress feature-specific event propagation", () => {
    const preventDefault = vi.fn();
    applyDesktopContextMenuPolicy({
      target: targetWithClosestResult({}),
      preventDefault,
    });
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
