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

  it("renders Random as FAF's four-faction mark", () => {
    const markup = renderToStaticMarkup(<FactionIcon faction={5} />);

    expect(markup).toContain('aria-label="Random"');
    // The four faction colours, which is what makes it the mark rather than a
    // glyph: this one does not follow `currentColor`.
    for (const colour of ["#F7BC0B", "#E31B13", "#3DA936", "#3884C5"]) {
      expect(markup).toContain(colour);
    }
  });

  it("gives every Random mark its own mask ids", () => {
    // A roster draws a dozen of these at once. A fixed id repeated a dozen
    // times in one document is invalid, and every copy would resolve its
    // masks against the first one's.
    const markup = renderToStaticMarkup(
      <>
        <FactionIcon faction={5} />
        <FactionIcon faction={5} />
      </>,
    );
    const ids = markup.match(/id="([^"]+)"/g) ?? [];
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders nothing for an unknown faction", () => {
    expect(renderToStaticMarkup(<FactionIcon faction={99} />)).toBe("");
  });
});
