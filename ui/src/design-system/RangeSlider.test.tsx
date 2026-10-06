import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RangeSlider } from "./RangeSlider";

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

  it("renders a single value when both endpoint labels are the same", () => {
    const markup = renderToStaticMarkup(
      <RangeSlider
        label="Density"
        min={0}
        max={127}
        low={127}
        high={null}
        format={(value) => `${Math.round((value / 127) * 100)}%`}
        formatUnbounded={(side) => side === "high" ? "100%" : "0%"}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain(">100%</span>");
    expect(markup).not.toContain("100% to 100%");
  });

  it("formats an unbounded low endpoint as zero when only one end is unbounded", () => {
    const markup = renderToStaticMarkup(
      <RangeSlider
        label="Density"
        min={0}
        max={127}
        low={null}
        high={64}
        format={(value) => `${Math.round((value / 127) * 100)}%`}
        formatUnbounded={(side) => side === "high" ? "100%" : "0%"}
        unboundedLabel="Any"
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain("0% to 50%");
    expect(markup).not.toContain("Any");
  });

  it("shows Any when both endpoints are unbounded", () => {
    const markup = renderToStaticMarkup(
      <RangeSlider
        label="Density"
        min={0}
        max={127}
        low={null}
        high={null}
        format={(value) => `${Math.round((value / 127) * 100)}%`}
        formatUnbounded={(side) => side === "high" ? "100%" : "0%"}
        unboundedLabel="Any"
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain(">Any</span>");
  });

  it("puts the high handle above the low handle when both are at the minimum", () => {
    const markup = renderToStaticMarkup(
      <RangeSlider
        label="Density"
        min={0}
        max={127}
        low={null}
        high={0}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain('range-slider-input-low is-unbounded" style="z-index:1');
    expect(markup).toContain('range-slider-input-high" style="z-index:2');
  });

  it("puts the low handle above the high handle when both are at the maximum", () => {
    const markup = renderToStaticMarkup(
      <RangeSlider
        label="Density"
        min={0}
        max={127}
        low={127}
        high={null}
        onChange={() => undefined}
      />,
    );

    expect(markup).toContain('range-slider-input-low" style="z-index:2');
    expect(markup).toContain('range-slider-input-high is-unbounded" style="z-index:1');
  });
});
