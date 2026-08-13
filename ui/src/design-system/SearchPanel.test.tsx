import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SearchField,
  SearchPanel,
  SearchPanelSubmit,
  SearchPanelToggle,
} from "./SearchPanel";

describe("SearchPanel", () => {
  it("keeps primary, secondary and advanced controls in one shared surface", () => {
    const markup = renderToStaticMarkup(
      <SearchPanel
        secondary={<SearchPanelToggle expanded={false} count={2} onClick={() => {}} />}
        advanced={<div className="search-panel-advanced">Advanced</div>}
      >
        <SearchField label="Map">
          <input className="search-panel-control" />
        </SearchField>
        <SearchPanelSubmit />
      </SearchPanel>,
    );

    expect(markup).toContain('class="search-panel surface-panel"');
    expect(markup).toContain('class="search-panel-primary"');
    expect(markup).toContain('class="search-panel-secondary"');
    expect(markup).toContain("More filters (2)");
    expect(markup).toContain("Advanced");
  });

  it("announces an expanded filter section", () => {
    const markup = renderToStaticMarkup(
      <SearchPanelToggle expanded count={0} onClick={() => {}} />,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Fewer filters");
  });
});
