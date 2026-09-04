import { describe, expect, it } from "vitest";
import { numberFromEdit } from "./NumberInput";

describe("numberFromEdit", () => {
  it("reads a number the parent can use", () => {
    expect(numberFromEdit("7")).toBe(7);
    expect(numberFromEdit("-250")).toBe(-250);
    expect(numberFromEdit(" 42 ")).toBe(42);
    expect(numberFromEdit("0")).toBe(0);
  });

  it("reports nothing for the states an edit passes through", () => {
    // The bug this exists for: an empty field used to arrive as a zero, which
    // the parent then put back on screen.
    expect(numberFromEdit("")).toBeNull();
    expect(numberFromEdit("   ")).toBeNull();
    // Halfway into typing a negative rating bound.
    expect(numberFromEdit("-")).toBeNull();
    expect(numberFromEdit("+")).toBeNull();
  });

  it("reports nothing for what is not a number at all", () => {
    expect(numberFromEdit("Infinity")).toBeNull();
    expect(numberFromEdit("-Infinity")).toBeNull();
    expect(numberFromEdit("nonsense")).toBeNull();
  });
});
