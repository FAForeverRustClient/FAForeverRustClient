import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_REPLAY_VIEW, ReplayViewSwitch } from "./ReplayViewSwitch";

describe("ReplayViewSwitch", () => {
  it("defaults replay libraries to tiles", () => {
    expect(DEFAULT_REPLAY_VIEW).toBe("tiles");
  });

  it("exposes tile and list choices with the active mode pressed", () => {
    const markup = renderToStaticMarkup(<ReplayViewSwitch value="tiles" onChange={() => undefined} />);

    expect(markup).toContain('aria-label="Tile view"');
    expect(markup).toContain('aria-label="List view"');
    expect(markup).toContain('aria-pressed="true"');
  });
});
