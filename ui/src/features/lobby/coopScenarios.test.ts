import { describe, expect, it } from "vitest";
import type { CoopScenario } from "../../ipc/bindings";
import { scenarioBadge, sortCoopScenarios } from "./coopScenarios";

function scenario(
  name: string,
  faction: CoopScenario["faction"],
  category: CoopScenario["category"],
  order: number,
): CoopScenario {
  return { id: order, name, description: "", order, faction, category };
}

// The campaigns FAF actually serves, deliberately shuffled.
const CATALOG = [
  scenario("Seraphim Campaign", "seraphim", "custom", 6),
  scenario("Vanilla Aeon Campaign", "aeon", "sc", 3),
  scenario("Forged Alliance Campaign", "custom", "scfa", 4),
  scenario("Vanilla UEF Campaign", "uef", "sc", 1),
  scenario("Coalition Campaign", "custom", "custom", 5),
  scenario("Vanilla Cybran Campaign", "cybran", "sc", 2),
];

describe("co-op campaign ordering", () => {
  it("opens with the vanilla campaigns and ends with community work", () => {
    expect(sortCoopScenarios(CATALOG).map((entry) => entry.name)).toEqual([
      "Vanilla UEF Campaign",
      "Vanilla Cybran Campaign",
      "Vanilla Aeon Campaign",
      "Forged Alliance Campaign",
      "Coalition Campaign",
      "Seraphim Campaign",
    ]);
  });

  it("keeps the groups apart even when the API sends no useful order", () => {
    // Sorting by faction alone put the community Seraphim campaign fourth,
    // ahead of the retail Forged Alliance one, because that campaign's faction
    // is `custom`. The category has to win before faction is consulted.
    const unordered = CATALOG.map((entry) => ({ ...entry, order: 0 }));
    const grouped = sortCoopScenarios(unordered).map((entry) => entry.category);
    expect(grouped).toEqual(["sc", "sc", "sc", "scfa", "custom", "custom"]);
  });

  it("labels a retail campaign official and community work custom", () => {
    const byName = new Map(CATALOG.map((entry) => [entry.name, entry]));
    expect(scenarioBadge(byName.get("Forged Alliance Campaign")!)).toBe("official");
    expect(scenarioBadge(byName.get("Coalition Campaign")!)).toBe("custom");
    expect(scenarioBadge(byName.get("Vanilla UEF Campaign")!)).toBe("uef");
    expect(scenarioBadge(byName.get("Seraphim Campaign")!)).toBe("seraphim");
  });
});
