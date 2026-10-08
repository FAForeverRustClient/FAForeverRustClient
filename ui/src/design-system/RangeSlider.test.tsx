import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RangeSlider, rangeReadout } from "./RangeSlider";

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
