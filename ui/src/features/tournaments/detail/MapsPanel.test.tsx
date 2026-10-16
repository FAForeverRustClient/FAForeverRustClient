// One pool holding every map on show is drawn once: the pool, with the full
// map cards in it, and no "All maps" repeating the same maps with the pool's
// name on each. A second pool, or a map outside the pool, keeps both sections.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MapPool, TourneyMap } from "../../../ipc/bindings";
import { tourney } from "../fixtures";
import { MapsPanel } from "./MapsPanel";

function map(id: string, name: string): TourneyMap {
  return {
    id,
    name,
    imageUrl: "",
    description: "",
    published: true,
    spec: { team1Spawns: [], team2Spawns: [], closedSpawns: [7, 8], closedMexSpawns: [], size: "" },
    secret: false,
    masked: false,
  };
}

function pool(id: string, name: string, mapIds: string[]): MapPool {
  return { id, name, mapIds, sequence: [], bestOf: 3, published: true, publishAt: null };
}

const maps = [map("corona", "Corona"), map("kappa", "Kappa"), map("wonder", "Wonder")];

function markup(pools: MapPool[], mapDb: TourneyMap[] = maps) {
  return renderToStaticMarkup(
    <MapsPanel event={tourney({ mapDb, mapPools: pools })} vault={[]} assetBase="" onManage={() => {}} />,
  );
}

describe("the Maps tab", () => {
  it("shows one section when a single pool holds every map", () => {
    const html = markup([pool("p1", "Challengers Cup", ["corona", "kappa", "wonder"])]);
    expect(html).not.toContain(">All maps<");
    expect(html.match(/tournament-mapdb-card/g)).toHaveLength(3);
    // The spawns are in the pool's cards; its name is not repeated on them.
    expect(html).toContain("Closed spawns");
    expect(html).not.toContain("tournament-badge is-ok");
  });

  it("draws a generated map by its seed, at full strength rather than as a disabled button", () => {
    const generated = map("g1", "neroxis_map_generator_1.22.2_yzlqo3opnhdoi_ayfqeaa_aaaaaadkw");
    const html = markup([pool("p1", "Round 1", ["g1"])], [generated]);
    expect(html).toContain("Generated map");
    expect(html).toContain("1.22.2 · yzlqo3opnhdoi_ayfqeaa_aaaaaadkw");
    expect(html).toContain("tournament-map-tile is-static");
    expect(html).not.toMatch(/<button[^>]*tournament-map-tile[^>]*disabled/);
  });

  it("keeps both sections when a map is outside the pool", () => {
    const html = markup([pool("p1", "Challengers Cup", ["corona", "kappa"])]);
    expect(html).toContain(">All maps<");
  });

  it("keeps both sections with more than one pool", () => {
    const html = markup([pool("p1", "Groups", ["corona", "kappa", "wonder"]), pool("p2", "Finals", ["corona"])]);
    expect(html).toContain(">All maps<");
  });
});
