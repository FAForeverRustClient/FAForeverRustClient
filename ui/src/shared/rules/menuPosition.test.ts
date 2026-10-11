import { describe, expect, it } from "vitest";
import { menuPosition } from "./menuPosition";

const menu = { width: 220, height: 360 };
const viewport = { width: 1100, height: 720 };

describe("player menu placement", () => {
  it("leaves the name visible when opened in the middle of a row", () => {
    const anchor = { left: 350, right: 410, top: 220, bottom: 240 };
    const position = menuPosition({ x: 385, y: 230 }, anchor, menu, viewport);
    expect(position.x).toBeGreaterThan(anchor.right);
    expect(position.y + menu.height).toBeLessThanOrEqual(viewport.height - 8);
  });

  it("flips left and up at the lower right edge", () => {
    const anchor = { left: 1000, right: 1070, top: 680, bottom: 704 };
    const position = menuPosition({ x: 1040, y: 690 }, anchor, menu, viewport);
    expect(position.x + menu.width).toBeLessThan(anchor.left);
    expect(position.y + menu.height).toBe(viewport.height - 8);
  });

  it("uses space below a wide roster row", () => {
    const anchor = { left: 8, right: 1092, top: 80, bottom: 112 };
    const position = menuPosition({ x: 1040, y: 96 }, anchor, menu, viewport);
    expect(position.y).toBeGreaterThan(anchor.bottom);
    expect(position.x + menu.width).toBeLessThanOrEqual(viewport.width - 8);
  });

  it("scrolls a tall menu above a wide row rather than covering it", () => {
    const anchor = { left: 8, right: 1092, top: 400, bottom: 430 };
    const position = menuPosition({ x: 385, y: 410 }, anchor, { ...menu, height: 600 }, viewport);
    expect(position.y + position.maxHeight).toBeLessThan(anchor.top);
    expect(position.maxHeight).toBeGreaterThan(0);
  });
});
