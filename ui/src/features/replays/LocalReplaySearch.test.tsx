import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalReplaySearch } from "./LocalReplaySearch";
import { EMPTY_LOCAL_REPLAY_QUERY } from "./localReplayQuery";

describe("LocalReplaySearch", () => {
  it("uses the online vault search structure and core replay filters", () => {
    const markup = renderToStaticMarkup(
      <LocalReplaySearch
        initialQuery={EMPTY_LOCAL_REPLAY_QUERY}
        self="TestPlayer"
        featuredMods={["faf"]}
        loading={false}
        busy={false}
        onSearch={() => undefined}
        onRefresh={() => undefined}
        onOpenFile={() => undefined}
      />,
    );

    expect(markup).toContain('class="vault-search local-vault-search search-panel surface-panel"');
    expect(markup).toContain("Player");
    expect(markup).toContain("Map");
    expect(markup).toContain("Replay ID");
    expect(markup).toContain("Mod");
    expect(markup).toContain("Rating");
    expect(markup).toContain("My replays");
    expect(markup).toContain("More filters");
  });
});
