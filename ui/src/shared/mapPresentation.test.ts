import { describe, expect, it } from "vitest";
import {
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

  it("returns /generated-map.svg for generated map candidates", () => {
    const candidates = mapThumbnailCandidates(
      [],
      "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko",
    );
    expect(candidates).toEqual(["/generated-map.svg"]);
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
      "/generated-map.svg",
    ]);
  });

  it("prioritizes generatedPreview over custom replay thumbnail URL for generated maps", () => {
    const candidates = mapThumbnailCandidates(
      [],
      "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko",
      false,
      undefined,
      "data:image/png;base64,previewdata",
      "/generated-map.svg",
    );
    expect(candidates).toEqual([
      "data:image/png;base64,previewdata",
      "/generated-map.svg",
    ]);
  });

  it("formats generated map presentation using Neroxis Map Generator as displayName", () => {
    const presentation = mapPresentation(
      [],
      "neroxis_map_generator_1.21.2_ybufyzg64pai2_aqfqeai_aaaaaadkqocko",
    );
    expect(presentation.displayName).toBe("Neroxis Map Generator");
    expect(presentation.thumbnailUrl).toBe("/generated-map.svg");
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
