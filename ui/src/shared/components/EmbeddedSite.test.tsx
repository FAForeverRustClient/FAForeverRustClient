import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmbeddedSite, SLOW_LOAD_MS } from "./EmbeddedSite";

describe("an embedded site", () => {
  const markup = renderToStaticMarkup(
    <EmbeddedSite url="https://unitdb.faforever.com/" title="Unit database" />,
  );

  it("says it is loading until the frame reports in", () => {
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading…");
  });

  it("offers a reload beside the way out to a real browser", () => {
    expect(markup).toContain("Reload");
    expect(markup).toContain("Open in browser");
    expect(markup).toContain('title="Unit database"');
  });

  it("keeps the slow-load notice back until a load has really run long", () => {
    // Shown only once the timer has fired for this very attempt, which no
    // first render has: a page that is merely not instant is not stuck.
    expect(markup).not.toContain("taking longer");
    expect(SLOW_LOAD_MS).toBeGreaterThanOrEqual(10_000);
  });
});
