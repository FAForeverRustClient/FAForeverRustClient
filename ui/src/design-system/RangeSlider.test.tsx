import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { collapsedHandleForDrag, RangeSlider } from "./RangeSlider";

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

  it("puts the right handle on top at the minimum and the left at the maximum", () => {
    const atMinimum = renderToStaticMarkup(
      <RangeSlider label="Density" min={0} max={127} low={0} high={0} onChange={() => undefined} />,
    );
    const atMaximum = renderToStaticMarkup(
      <RangeSlider label="Density" min={0} max={127} low={127} high={127} onChange={() => undefined} />,
    );

    expect(atMinimum).toMatch(/class="[^"]*range-slider-input-high[^"]*" style="z-index:2"/);
    expect(atMaximum).toMatch(/class="[^"]*range-slider-input-low[^"]*" style="z-index:2"/);
    expect(atMaximum).toMatch(/class="[^"]*range-slider-input-high[^"]*" style="z-index:1"/);
  });

  it("chooses the collapsed handle from the initial drag direction", () => {
    expect(collapsedHandleForDrag(-1)).toBe("low");
    expect(collapsedHandleForDrag(1)).toBe("high");
    expect(collapsedHandleForDrag(0)).toBeNull();
  });
});
