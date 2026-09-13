import { describe, expect, it } from "vitest";
import type { VaultMap } from "../ipc/bindings";
import {
  GENERATED_MAP_PLACEHOLDER_URL,
  effectiveReplayMapName,
  extractGeneratedMapSeed,
  isGeneratedMap,
  mapPresentation,
  mapSize,
  mapSizeOf,
  mapThumbnailCandidates,
} from "./mapPresentation";

describe("mapPresentation", () => {
  it("recognizes generated map names in snake_case and formatted variants", () => {
    expect(
      isGeneratedMap(
        "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko",
      ),
    ).toBe(true);
    expect(
      isGeneratedMap(
        "Neroxis Map Generator 1.21.2 Ybufyzg64pai2 Aqfqeai Aaaaaadkqocko",
      ),
    ).toBe(true);
    expect(isGeneratedMap("neroxis_v1")).toBe(true);
    expect(isGeneratedMap("scmp_001")).toBe(false);
    expect(isGeneratedMap("Seton's Clutch")).toBe(false);
    expect(isGeneratedMap("")).toBe(false);
  });

  it("returns the mapgen placeholder for generated map candidates", () => {
    const candidates = mapThumbnailCandidates(
      [],
      "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko",
    );
    expect(candidates).toEqual([GENERATED_MAP_PLACEHOLDER_URL]);
  });

  it("includes local generated preview when available", () => {
    const candidates = mapThumbnailCandidates(
      [],
      "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko",
      false,
      undefined,
      "data:image/png;base64,previewdata",
    );
    expect(candidates).toEqual([
      "data:image/png;base64,previewdata",
      GENERATED_MAP_PLACEHOLDER_URL,
    ]);
  });

  it("prioritizes generatedPreview over custom replay thumbnail URL for generated maps", () => {
    const candidates = mapThumbnailCandidates(
      [],
      "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko",
      false,
      undefined,
      "data:image/png;base64,previewdata",
      GENERATED_MAP_PLACEHOLDER_URL,
    );
    expect(candidates).toEqual([
      "data:image/png;base64,previewdata",
      GENERATED_MAP_PLACEHOLDER_URL,
    ]);
  });

  it("replaces the deleted SVG placeholder when an older replay payload still references it", () => {
    const candidates = mapThumbnailCandidates(
      [],
      "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko",
      false,
      undefined,
      undefined,
      "/generated-map.svg",
    );
    expect(candidates).toEqual([GENERATED_MAP_PLACEHOLDER_URL]);
  });

  it("can prefer the clean canonical preview over stale vault artwork", () => {
    const staleVaultMap = {
      folderName: "scmp_009",
      displayName: "Seton's Clutch",
      thumbnailUrl: "https://content.faforever.com/maps/previews/small/scmp_009.png",
      thumbnailUrlLarge: "https://content.faforever.com/maps/previews/large/scmp_009.png",
    } as VaultMap;

    const candidates = mapThumbnailCandidates(
      [staleVaultMap],
      "scmp_009",
      false,
      undefined,
      undefined,
      undefined,
      true,
    );

    expect(candidates[0]).toBe("https://content.faforever.com/maps/previews/small/scmp_009.png");
    expect(candidates).not.toContain(staleVaultMap.thumbnailUrlLarge);
  });

  it("answers for one map when the vault holds a record over a base-game folder", () => {
    // A vault record whose folder collides with a base-game map, describing
    // something else entirely. The Play tab used to take the name from the
    // built-in catalogue and the size and the picture from this, which is how
    // a lobby on The Ditch came to be announced as 20 x 10 km with a picture
    // of another map.
    const colliding = {
      folderName: "scmp_040",
      displayName: "Somebody's Remake",
      width: 1024,
      height: 512,
      thumbnailUrl: "https://example.invalid/remake-small.png",
      thumbnailUrlLarge: "https://example.invalid/remake-large.png",
    } as VaultMap;

    expect(mapPresentation([colliding], "scmp_040").displayName).toBe("The Ditch");
    expect(mapSize([colliding], "scmp_040")?.compact).toBe("10 km");
    expect(mapThumbnailCandidates([colliding], "scmp_040")[0]).toBe(
      "https://content.faforever.com/maps/previews/small/scmp_040.png",
    );
  });

  it("formats generated map presentation using Neroxis Map Generator as displayName", () => {
    const presentation = mapPresentation(
      [],
      "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko",
    );
    expect(presentation.displayName).toBe("Neroxis Map Generator");
    expect(presentation.thumbnailUrl).toBe(GENERATED_MAP_PLACEHOLDER_URL);
  });

  it("extracts generated map seed accurately and avoids generic labels", () => {
    expect(
      extractGeneratedMapSeed(
        "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko",
      ),
    ).toBe("ybufyzg64pai2_aqfqeai_aaaaaadkqocko");
    expect(
      extractGeneratedMapSeed("neroxis_map_generator_1.7.7_abcdef"),
    ).toBe("abcdef");
    expect(extractGeneratedMapSeed("Neroxis Map Generator")).toBeUndefined();
    expect(extractGeneratedMapSeed("neroxis_map_generator")).toBeUndefined();
    expect(extractGeneratedMapSeed("Seton's Clutch")).toBeUndefined();
  });

  it("uses a matching local technical map name for generated replay previews", () => {
    const technicalName = "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko";
    expect(effectiveReplayMapName("Neroxis Map Generator", technicalName)).toBe(technicalName);
    expect(effectiveReplayMapName("Seton's Clutch", "scmp_009")).toBe("Seton's Clutch");
    expect(effectiveReplayMapName("Neroxis Map Generator", null)).toBe("Neroxis Map Generator");
  });
});

describe("mapSize", () => {
  it("says a square map once", () => {
    // 512 generator units is the 10 km map everybody knows by that number.
    // "10 × 10 km" spends a tile's whole corner repeating itself.
    expect(mapSizeOf(512, 512)).toEqual({ full: "10 × 10 km", compact: "10 km" });
    expect(mapSizeOf(256, 256)?.compact).toBe("5 km");
    expect(mapSizeOf(1024, 1024)?.compact).toBe("20 km");
  });

  it("spells out a map that is not square", () => {
    expect(mapSizeOf(512, 256)).toEqual({ full: "10 × 5 km", compact: "10 × 5 km" });
  });

  it("keeps the quarter kilometres the generator actually produces", () => {
    // The generator steps in 64 units, which is 1.25 km. Rounding to whole
    // kilometres announced a 17.5 km map as 18 -- a size no map has -- and the
    // two smallest as 1 km and 3 km.
    expect(mapSizeOf(896, 896)?.compact).toBe("17.5 km");
    expect(mapSizeOf(320, 320)?.compact).toBe("6.25 km");
    expect(mapSizeOf(64, 64)?.compact).toBe("1.25 km");
    expect(mapSizeOf(128, 128)?.compact).toBe("2.5 km");
    // And a whole number stays whole: no "20.00 km" anywhere.
    expect(mapSizeOf(2048, 2048)?.compact).toBe("40 km");
  });

  it("has nothing to say about a size of zero", () => {
    // Which is what an absent width looks like once it crosses the wire.
    expect(mapSizeOf(0, 512)).toBeNull();
    expect(mapSizeOf(512, 0)).toBeNull();
  });

  it("reads the vault first", () => {
    const vaultMap = {
      folderName: "koprulu_sector.v0003",
      displayName: "Koprulu Sector",
      width: 1024,
      height: 1024,
    } as VaultMap;

    expect(mapSize([vaultMap], "koprulu_sector.v0003")?.compact).toBe("20 km");
  });

  it("falls back to the built-in table for a base-game map", () => {
    // Base-game maps are not vault records, so a vault lookup never finds
    // them, and they are exactly the maps most people are hosting.
    expect(mapSize([], "scmp_009")?.compact).toBe("20 km");
    expect(mapSize([], "scmp_012")?.compact).toBe("5 km");
    expect(mapSize([], "scmp_007")?.compact).toBe("10 km");
  });

  it("takes a generated map's size from its decoded name", () => {
    const generated = "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai";
    expect(mapSize([], generated)).toBeNull();
    expect(mapSize([], generated, 512)?.compact).toBe("10 km");
  });

  it("says nothing rather than guessing", () => {
    // A badge reading 10 km because that is the common size would be worse
    // than no badge: it is the number somebody is deciding on.
    expect(mapSize([], "some_custom_map_nobody_has")).toBeNull();
  });
});
