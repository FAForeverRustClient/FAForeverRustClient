// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { collapsedHandleForDrag, RangeSlider, rangeReadout } from "./RangeSlider";

describe("RangeSlider", () => {
  it("uses a plain-language separator for bounded values", () => {
    const markup = renderToStaticMarkup(
      <RangeSlider
        label="Rating"
        min={-1000}
        max={4000}
        low={1000}
        high={2000}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain("1000 to 2000");
  });

  it("renders Any when unbounded on both ends", () => {
    const markup = renderToStaticMarkup(
      <RangeSlider
        label="Rating"
        min={-1000}
        max={4000}
        low={null}
        high={null}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain("Any");
    expect(markup).toContain("is-unbounded");
  });

  it("chooses the collapsed handle from the initial drag direction", () => {
    expect(collapsedHandleForDrag(-3)).toBe("low");
    expect(collapsedHandleForDrag(3)).toBe("high");
    expect(collapsedHandleForDrag(-2)).toBeNull();
    expect(collapsedHandleForDrag(2)).toBeNull();
    expect(collapsedHandleForDrag(0)).toBeNull();
  });

  it("does not choose a handle until the drag passes the threshold, then focuses it", () => {
    const onChange = vi.fn();
    const { container } = render(
      <RangeSlider label="Density" min={0} max={127} low={64} high={64} onChange={onChange} />,
    );
    const track = container.querySelector<HTMLElement>(".range-slider-track");
    const [lowInput, highInput] = Array.from(
      container.querySelectorAll<HTMLInputElement>(".range-slider-input"),
    );
    if (!track) throw new Error("Range slider track was not rendered");
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 127, 34));
    track.setPointerCapture = () => undefined;
    track.hasPointerCapture = () => false;

    fireEvent.pointerDown(lowInput, { pointerId: 1, clientX: 64 });
    fireEvent.pointerMove(track, { pointerId: 1, clientX: 66 });
    expect(document.activeElement).not.toBe(lowInput);
    expect(document.activeElement).not.toBe(highInput);
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.pointerMove(track, { pointerId: 1, clientX: 67 });
    expect(document.activeElement).toBe(highInput);
    expect(onChange).toHaveBeenLastCalledWith(64, 67);
    fireEvent.pointerUp(track, { pointerId: 1 });
  });

  describe("readout (#459)", () => {
    const base = { min: 0, max: 100, format: (v: number) => `${v}%`, any: "any" };
    const between = (low: string, high: string) => `${low} to ${high}`;

    it("names the ends of a closed scale instead of saying any", () => {
      expect(rangeReadout({ ...base, low: null, high: 65, closedScale: true }, between)).toBe("0% to 65%");
      expect(rangeReadout({ ...base, low: 34, high: null, closedScale: true }, between)).toBe("34% to 100%");
    });

    it("still says any for an open side of an open scale", () => {
      expect(rangeReadout({ ...base, low: 34, high: null, closedScale: false }, between)).toBe("34% to any");
    });

    it("shows one value when both handles sit on it", () => {
      expect(rangeReadout({ ...base, low: 76, high: 76, closedScale: true }, between)).toBe("76%");
    });

    it("says any when nothing is set", () => {
      expect(rangeReadout({ ...base, low: null, high: null, closedScale: true }, between)).toBe("any");
    });
  });
});
