import { describe, expect, it } from "vitest";
import { nextListboxIndex, WheelStepper } from "./listboxNavigation";

describe("listbox keyboard navigation", () => {
  it("steps one row at a time", () => {
    expect(nextListboxIndex("ArrowDown", 3, 10)).toBe(4);
    expect(nextListboxIndex("ArrowUp", 3, 10)).toBe(2);
  });

  it("stops at the ends rather than wrapping", () => {
    expect(nextListboxIndex("ArrowDown", 9, 10)).toBe(9);
    expect(nextListboxIndex("ArrowUp", 0, 10)).toBe(0);
  });

  it("jumps a screenful, clamped", () => {
    expect(nextListboxIndex("PageDown", 0, 400)).toBe(10);
    expect(nextListboxIndex("PageUp", 4, 400)).toBe(0);
    expect(nextListboxIndex("PageDown", 397, 400)).toBe(399);
  });

  it("goes to the first and last row", () => {
    expect(nextListboxIndex("Home", 200, 400)).toBe(0);
    expect(nextListboxIndex("End", 200, 400)).toBe(399);
  });

  it("lands on the first row when nothing is selected yet", () => {
    expect(nextListboxIndex("ArrowUp", -1, 10)).toBe(0);
    expect(nextListboxIndex("ArrowDown", -1, 10)).toBe(0);
  });

  it("leaves keys the list does not own alone", () => {
    // Typing has to keep reaching the search field above the list, and Escape
    // has to keep closing the dialog.
    for (const key of ["a", " ", "Escape", "Tab", "Enter"]) {
      expect(nextListboxIndex(key, 3, 10)).toBeNull();
    }
  });

  it("does nothing in an empty list", () => {
    expect(nextListboxIndex("ArrowDown", -1, 0)).toBeNull();
  });
});

describe("Ctrl+wheel through a list (#642)", () => {
  const wheel = (deltaY: number, ctrlKey = true) => ({ ctrlKey, deltaY });

  it("leaves the plain wheel to scroll", () => {
    expect(new WheelStepper().next(wheel(100, false), 3, 10)).toBeNull();
  });

  it("moves a row per mouse notch, down and up", () => {
    const stepper = new WheelStepper();
    expect(stepper.next(wheel(100), 3, 10)).toBe(4);
    expect(stepper.next(wheel(-120), 4, 10)).toBe(3);
  });

  it("gathers a touchpad's small deltas into one row", () => {
    const stepper = new WheelStepper();
    expect(stepper.next(wheel(20), 3, 10)).toBe(3);
    expect(stepper.next(wheel(20), 3, 10)).toBe(3);
    expect(stepper.next(wheel(20), 3, 10)).toBe(4);
  });

  it("stops at the ends rather than wrapping", () => {
    expect(new WheelStepper().next(wheel(100), 9, 10)).toBe(9);
    expect(new WheelStepper().next(wheel(-100), 0, 10)).toBe(0);
  });
});
