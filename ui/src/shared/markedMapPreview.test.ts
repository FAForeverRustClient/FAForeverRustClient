import { describe, expect, it } from "vitest";
import { markerPlacements } from "./markedMapPreview";

describe("markerPlacements", () => {
  const preview = {
    width: 1024,
    height: 1024,
    mass: [[512, 256]] as [number, number][],
    hydro: [[256, 512]] as [number, number][],
    spawns: [[100, 900]] as [number, number][],
  };

  it("centres each icon on its marker, scaled from map units to pixels", () => {
    const [hydro, mass, spawn] = markerPlacements(preview, 1024, 1024);
    expect(mass).toEqual({ kind: "mass", x: 502, y: 246, width: 20, height: 20 });
    expect(hydro.x + hydro.width / 2).toBe(256);
    expect(hydro.y + hydro.height / 2).toBe(512);
    expect(spawn.x + spawn.width / 2).toBe(100);
    expect(spawn.y + spawn.height / 2).toBe(900);
  });

  it("draws hydros first and the spawns last, as the vault's previews do", () => {
    expect(markerPlacements(preview, 1024, 1024).map((placement) => placement.kind))
      .toEqual(["hydro", "mass", "spawn"]);
  });

  it("scales each axis on its own", () => {
    const [, mass] = markerPlacements({ ...preview, width: 512 }, 1024, 512);
    // x: 512 of 512 units is the right edge; z: 256 of 1024 units is a quarter.
    expect(mass.x + mass.width / 2).toBe(1024);
    expect(mass.y + mass.height / 2).toBe(128);
  });
});
