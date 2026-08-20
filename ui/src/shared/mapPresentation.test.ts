import { describe, expect, it } from "vitest";
import {
  GENERATED_MAP_PLACEHOLDER_URL,
  extractGeneratedMapSeed,
  isGeneratedMap,
  mapPresentation,
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
});
