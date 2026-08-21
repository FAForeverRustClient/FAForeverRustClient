import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import { VaultSearch } from "./VaultSearch";

describe("VaultSearch", () => {
  it("keeps the established Online replay search structure", () => {
    const markup = renderToStaticMarkup(
      <VaultSearch
        featuredMods={["faf"]}
        leaderboards={[]}
        self="TestPlayer"
        initialQuery={EMPTY_REPLAY_QUERY}
        onSearch={() => undefined}
      />,
    );

    expect(markup).toContain(
      'class="vault-search online-vault-search search-panel surface-panel"',
    );
    expect(markup).toContain('class="vault-input search-panel-control vault-sort-order"');
    expect(markup).toContain('class="btn-primary vault-search-submit search-panel-submit"');
    expect(markup.indexOf("vault-sort-order")).toBeLessThan(markup.indexOf("vault-search-submit"));
  });
});
