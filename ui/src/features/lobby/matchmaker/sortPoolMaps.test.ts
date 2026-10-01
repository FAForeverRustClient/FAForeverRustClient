import { describe, expect, it } from "vitest";
import { sortPoolMaps } from "./MatchmakerMapPoolModal";

const map = (displayName: string, km: number) => ({ displayName, width: km * 51.2, height: km * 51.2 });

describe("a map pool's order (#403)", () => {
  it("is smallest first, then by name, as the Java client lists it", () => {
    const pool = [map("Gateway and Rose", 20), map("Rotun", 10), map("sandstorm", 5), map("Azalea Gardens", 10), map("Desert Arena", 5)];
    expect(sortPoolMaps(pool).map((entry) => entry.displayName)).toEqual([
      "Desert Arena",
      "sandstorm",
      "Azalea Gardens",
      "Rotun",
      "Gateway and Rose",
    ]);
  });
});
