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

  it("chooses the collapsed handle from the initial drag direction", () => {
    expect(collapsedHandleForDrag(-1)).toBe("low");
    expect(collapsedHandleForDrag(1)).toBe("high");
    expect(collapsedHandleForDrag(0)).toBeNull();
  });
});
