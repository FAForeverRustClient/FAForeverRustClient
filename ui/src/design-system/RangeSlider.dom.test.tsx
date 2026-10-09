// @vitest-environment happy-dom
//
// The two-thumb range slider driven from the keyboard, mounted.
//
// Each thumb is a native `<input type="range">`, so the keys themselves are
// the browser's: the component adds no key handling of its own, and what it
// owns is what happens to the value a key produces (snapped to the step,
// stopped at the other thumb, turned into "no limit" at the ends) and the
// `min`, `max` and `value` each thumb carries, from which the browser derives
// `aria-valuemin`, `aria-valuemax` and `aria-valuenow`. Neither happy-dom nor
// user-event implements a range input's keyboard, so `nativeRangeKey` below
// stands in for the browser, following Chromium's `RangeInputType`. That is
// the one part of these tests that is not the real thing.
//
// Not covered, because happy-dom has no layout: pressing on the track to move
// the nearer thumb (it measures the track), and which thumb is on top where
// the two overlap, beyond the `z-index` each one is given.

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failOnConsoleError } from "../testing/consoleGuard";
import "../testing/mounted";
import { RangeSlider } from "./RangeSlider";

vi.mock("../ipc/client");

failOnConsoleError();

// The prototype's setter rather than `input.value = ...`: React watches the
// element's own `value` property to tell its writes from the user's, and a
// value written through it would not count as a change.
const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

/**
 * The browser's default action for a key on a focused range input: the arrows
 * step by `step`, Page Up and Page Down by a tenth of the range (at least one
 * step), Home and End go to the ends; the result is clamped, snapped to the
 * step, and announced with `input` and `change` when it differs. Listening on
 * the document runs it after React's handlers, as a default action would, and
 * a handler that cancelled the key would have stopped it.
 */
function nativeRangeKey(event: KeyboardEvent) {
  const input = event.target;
  if (event.defaultPrevented || !(input instanceof HTMLInputElement) || input.type !== "range") return;
  const min = Number(input.min);
  const max = Number(input.max);
  const step = Number(input.step) || 1;
  const current = Number(input.value);
  const bigStep = Math.max((max - min) / 10, step);
  const targets: Record<string, number> = {
    ArrowRight: current + step,
    ArrowUp: current + step,
    ArrowLeft: current - step,
    ArrowDown: current - step,
    PageUp: current + bigStep,
    PageDown: current - bigStep,
    Home: min,
    End: max,
  };
  const target = targets[event.key];
  if (target === undefined) return;
  event.preventDefault();
  const next = Math.min(max, Math.max(min, min + Math.round((target - min) / step) * step));
  if (next === current) return;
  nativeValue?.set?.call(input, String(next));
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => document.addEventListener("keydown", nativeRangeKey));
afterEach(() => document.removeEventListener("keydown", nativeRangeKey));

type Range = { low: number | null; high: number | null };

/** A controlled slider over 0 to 100 in steps of 5, the way a filter holds one. */
function Harness({ initial, onChange }: { initial: Range; onChange: (low: number | null, high: number | null) => void }) {
  const [range, setRange] = useState(initial);
  return (
    <RangeSlider
      label="Rating"
      min={0}
      max={100}
      step={5}
      low={range.low}
      high={range.high}
      onChange={(low, high) => {
        onChange(low, high);
        setRange({ low, high });
      }}
    />
  );
}

function mount(initial: Range = { low: 20, high: 80 }) {
  const onChange = vi.fn<(low: number | null, high: number | null) => void>();
  const { container } = render(<Harness initial={initial} onChange={onChange} />);
  const readout = () => container.querySelector(".range-slider-value")?.textContent;
  return {
    onChange,
    readout,
    low: screen.getByRole<HTMLInputElement>("slider", { name: "Rating minimum" }),
    high: screen.getByRole<HTMLInputElement>("slider", { name: "Rating maximum" }),
  };
}

/** Put the keyboard on a thumb. Inside `act`, because focusing it raises it above the other. */
function focus(input: HTMLInputElement) {
  act(() => input.focus());
}

/** What each thumb tells assistive tech: its own bounds and its value. */
function thumb(input: HTMLInputElement) {
  return { min: input.min, max: input.max, value: input.value };
}

describe("RangeSlider keyboard, mounted", () => {
  it("steps one thumb by its step on the arrows, leaving the other where it was", async () => {
    const user = userEvent.setup();
    const { onChange, readout, low, high } = mount();
    expect(thumb(low)).toEqual({ min: "0", max: "100", value: "20" });
    expect(thumb(high)).toEqual({ min: "0", max: "100", value: "80" });

    focus(low);
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(25, 80);
    expect(thumb(low).value).toBe("25");
    expect(readout()).toBe("25 to 80");

    await user.keyboard("{ArrowUp}");
    expect(onChange).toHaveBeenLastCalledWith(30, 80);
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith(25, 80);
    await user.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenLastCalledWith(20, 80);
    expect(onChange).toHaveBeenCalledTimes(4);
    expect(thumb(low).value).toBe("20");
    expect(thumb(high).value).toBe("80");
    expect(document.activeElement).toBe(low);

    focus(high);
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith(20, 75);
    expect(thumb(high).value).toBe("75");
    expect(readout()).toBe("20 to 75");
  });

  it("moves by a tenth of the range on Page Up and Page Down", async () => {
    const user = userEvent.setup();
    const { onChange, low, high } = mount();

    focus(low);
    await user.keyboard("{PageUp}");
    expect(onChange).toHaveBeenLastCalledWith(30, 80);
    await user.keyboard("{PageDown}{PageDown}");
    expect(onChange).toHaveBeenLastCalledWith(10, 80);

    focus(high);
    await user.keyboard("{PageDown}");
    expect(onChange).toHaveBeenLastCalledWith(10, 70);
    expect(thumb(high).value).toBe("70");
  });

  it("opens a side again at its end of the scale with Home and End", async () => {
    const user = userEvent.setup();
    const { onChange, readout, low, high } = mount();

    focus(low);
    await user.keyboard("{Home}");
    // The bottom of the scale is "no lower limit", not a limit of 0.
    expect(onChange).toHaveBeenLastCalledWith(null, 80);
    expect(thumb(low).value).toBe("0");
    expect(readout()).toBe("Any to 80");

    focus(high);
    await user.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith(null, null);
    expect(thumb(high).value).toBe("100");
    expect(readout()).toBe("Any");

    // And back in from an open end, one step at a time.
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith(null, 95);
    expect(readout()).toBe("Any to 95");
  });

  it("stops each thumb at the other, whichever key pushes it", async () => {
    const user = userEvent.setup();
    const { onChange, readout, low, high } = mount();

    focus(low);
    await user.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith(80, 80);
    expect(thumb(low).value).toBe("80");
    expect(readout()).toBe("80");

    // Already touching: further presses hold it there rather than passing.
    await user.keyboard("{ArrowRight}{PageUp}");
    expect(onChange).toHaveBeenLastCalledWith(80, 80);
    expect(thumb(low).value).toBe("80");
    expect(thumb(high).value).toBe("80");

    focus(high);
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith(80, 80);
    await user.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith(80, 80);
    expect(thumb(high).value).toBe("80");
    expect(thumb(low).value).toBe("80");

    // Moving apart again still works from either side.
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(80, 85);
    focus(low);
    await user.keyboard("{ArrowLeft}");
    expect(onChange).toHaveBeenLastCalledWith(75, 85);
    expect(readout()).toBe("75 to 85");
  });

  it("does not report a change for a key that cannot move the thumb", async () => {
    const user = userEvent.setup();
    const { onChange, low, high } = mount({ low: null, high: null });

    focus(low);
    await user.keyboard("{Home}{ArrowLeft}{PageDown}");
    focus(high);
    await user.keyboard("{End}{ArrowRight}{PageUp}");
    expect(onChange).not.toHaveBeenCalled();
    expect(thumb(low).value).toBe("0");
    expect(thumb(high).value).toBe("100");
  });

  it("puts the thumb with the keyboard above the other one", async () => {
    const user = userEvent.setup();
    const { low, high } = mount({ low: 50, high: 50 });

    focus(high);
    expect(Number(high.style.zIndex)).toBeGreaterThan(Number(low.style.zIndex));
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(low);
    expect(Number(low.style.zIndex)).toBeGreaterThan(Number(high.style.zIndex));
  });
});
