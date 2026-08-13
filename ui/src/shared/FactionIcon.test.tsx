import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FactionIcon } from "./FactionIcon";

describe("FactionIcon", () => {
  it.each([
    [1, "UEF"],
    [2, "Aeon"],
    [3, "Cybran"],
    [4, "Seraphim"],
  ])("renders faction %i as the %s glyph", (faction, name) => {
    const markup = renderToStaticMarkup(<FactionIcon faction={faction} />);

    expect(markup).toContain(`<svg aria-label="${name}"`);
    expect(markup).toContain("<path");
    expect(markup).not.toContain(">&quot;");
  });

  it("renders Random as a neutral die marker", () => {
    const markup = renderToStaticMarkup(<FactionIcon faction={5} />);

    expect(markup).toContain('<svg aria-label="Random"');
    expect(markup).toContain("<rect");
    expect(markup.match(/<circle/g)).toHaveLength(5);
    expect(markup).toContain("var(--color-muted)");
  });

  it("renders nothing for an unknown faction", () => {
    expect(renderToStaticMarkup(<FactionIcon faction={99} />)).toBe("");
  });
});
