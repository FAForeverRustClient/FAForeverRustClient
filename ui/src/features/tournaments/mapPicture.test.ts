import { describe, expect, it } from "vitest";
import type { TourneyMap } from "../../ipc/bindings";
import { GENERATED_MAP_PLACEHOLDER_URL } from "../../shared/mapPresentation";
import { canEnlargeMapPicture, tourneyMapPicture } from "./mapPicture";

function map(name: string, imageUrl = ""): TourneyMap {
  return { id: name, name, imageUrl, description: "", published: true, spec: null, secret: false, masked: false };
}

const GENERATED = "neroxis_map_generator_1.22.2_yzlqo3opnhdoi_ayfqeaa_aaaaaadkw";

describe("tourneyMapPicture", () => {
  it("gives a generated map the generator's picture instead of none", () => {
    expect(tourneyMapPicture(map(GENERATED), "https://tournaments.example", [])).toBe(GENERATED_MAP_PLACEHOLDER_URL);
  });

  it("keeps the organiser's own upload for a generated map", () => {
    expect(tourneyMapPicture(map(GENERATED, "mapgen.png"), "https://tournaments.example", [])).toBe(
      "https://tournaments.example/map-images/mapgen.png",
    );
  });

  it("leaves an ordinary map the vault does not know without a picture", () => {
    expect(tourneyMapPicture(map("Corona"), "https://tournaments.example", [])).toBe("");
  });
});

describe("canEnlargeMapPicture", () => {
  it("opens real pictures but not the generator's placeholder or nothing", () => {
    expect(canEnlargeMapPicture("https://tournaments.example/map-images/corona.png")).toBe(true);
    expect(canEnlargeMapPicture(GENERATED_MAP_PLACEHOLDER_URL)).toBe(false);
    expect(canEnlargeMapPicture("")).toBe(false);
  });
});
