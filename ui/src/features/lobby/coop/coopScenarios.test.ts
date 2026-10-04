import { describe, expect, it } from "vitest";
import type { CoopScenario } from "../../../ipc/bindings";
import { translateIn } from "../../../i18n";
import {
  displayScenarioOptionLabel,
  displayScenarioName,
  scenarioBadge,
  sortCoopScenarios,
} from "./coopScenarios";

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

  describe("co-op campaign names", () => {
    it.each([
      [scenario("Vanilla UEF Campaign", "uef", "sc", 1), "Кампания ОФЗ (SC)"],
      [scenario("Vanilla Cybran Campaign", "cybran", "sc", 2), "Кампания Кибран (SC)"],
      [scenario("Vanilla Aeon Campaign", "aeon", "sc", 3), "Кампания Эон (SC)"],
    ])("uses the Russian campaign label for %s", (entry, expected) => {
      const t = (key: Parameters<typeof translateIn>[1], values?: Parameters<typeof translateIn>[2]) =>
        translateIn("ru", key, values);
      expect(displayScenarioName(entry, t)).toBe(expected);
    });

    it("uses the translated Forged Alliance name and retains its official badge", () => {
      const entry = scenario("Forged Alliance Campaign", "custom", "scfa", 1);
      const t = (key: Parameters<typeof translateIn>[1], values?: Parameters<typeof translateIn>[2]) =>
        translateIn("ru", key, values);
      expect(displayScenarioName(entry, t)).toBe("Кампания SCFA (Forged Alliance)");
      expect(scenarioBadge(entry)).toBe("official");
    });

    it("keeps the API campaign name for community campaigns", () => {
      const entry = scenario("Community Campaign", "custom", "custom", 1);
      const t = (key: Parameters<typeof translateIn>[1], values?: Parameters<typeof translateIn>[2]) =>
        translateIn("ru", key, values);
      expect(displayScenarioName(entry, t)).toBe("Community Campaign");
      expect(scenarioBadge(entry)).toBe("custom");
    });

    it.each([
      [scenario("Coalition Campaign", "custom", "custom", 1), "Кампания Коалиции", "custom"],
      [scenario("Standalone missions", "custom", "custom", 2), "Отдельные миссии", "custom"],
      [
        scenario("Seraphim Campaign", "seraphim", "custom", 3),
        "Кампания Серафим",
        "custom",
      ],
    ])("localizes community catalog label %s and keeps its badge", (entry, expected, badge) => {
      const t = (key: Parameters<typeof translateIn>[1], values?: Parameters<typeof translateIn>[2]) =>
        translateIn("ru", key, values);
      expect(displayScenarioName(entry, t)).toBe(expected);
      expect(scenarioBadge(entry)).toBe(badge);
    });

    it("resolves campaign names through the active locale catalogue", () => {
      const entry = scenario("Vanilla Aeon Campaign", "aeon", "sc", 1);
      for (const locale of ["en", "ru"] as const) {
        const t = (key: Parameters<typeof translateIn>[1], values?: Parameters<typeof translateIn>[2]) =>
          translateIn(locale, key, values);
        expect(displayScenarioName(entry, t)).toBe(
          locale === "en" ? "Vanilla Aeon Campaign" : "Кампания Эон (SC)",
        );
      }
    });

    it("localizes known campaigns even when API category and faction metadata differ", () => {
      const t = (key: Parameters<typeof translateIn>[1], values?: Parameters<typeof translateIn>[2]) =>
        translateIn("ru", key, values);
      const entries = [
        scenario("Vanilla UEF Campaign", "custom", "custom", 1),
        scenario("Vanilla Cybran Campaign", "custom", "custom", 2),
        scenario("Vanilla Aeon Campaign", "custom", "custom", 3),
        scenario("Forged Alliance Campaign", "uef", "custom", 4),
        scenario("Coalition Campaign", "custom", "sc", 5),
        scenario("Seraphim Campaign", "custom", "scfa", 6),
        scenario("Standalone missions", "custom", "sc", 7),
      ];

      expect(entries.map((entry) => displayScenarioName(entry, t))).toEqual([
        "Кампания ОФЗ (SC)",
        "Кампания Кибран (SC)",
        "Кампания Эон (SC)",
        "Кампания SCFA (Forged Alliance)",
        "Кампания Коалиции",
        "Кампания Серафим",
        "Отдельные миссии",
      ]);
    });

    it("uses catalogue option formats for official and community campaigns", () => {
      const t = (key: Parameters<typeof translateIn>[1], values?: Parameters<typeof translateIn>[2]) =>
        translateIn("ru", key, values);

      expect(
        displayScenarioOptionLabel(
          scenario("Vanilla UEF Campaign", "uef", "sc", 1),
          t,
        ),
      ).toBe("Кампания ОФЗ (SC)");
      expect(
        displayScenarioOptionLabel(
          scenario("Seraphim Campaign", "seraphim", "custom", 2),
          t,
        ),
      ).toBe("Кампания Серафим (От сообщества)");
      expect(
        displayScenarioOptionLabel(
          scenario("Forged Alliance Campaign", "custom", "scfa", 3),
          t,
        ),
      ).toBe("Кампания SCFA (Forged Alliance)");
      expect(
        displayScenarioOptionLabel(
          scenario("Coalition Campaign", "custom", "custom", 4),
          t,
        ),
      ).toBe("Кампания Коалиции (От сообщества)");
    });
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
    expect(scenarioBadge(byName.get("Seraphim Campaign")!)).toBe("custom");
    expect(scenarioBadge(scenario("Another campaign", "seraphim", "sc", 7))).toBe("seraphim");
    expect(scenarioBadge(scenario("Another community campaign", "seraphim", "custom", 8)))
      .toBe("custom");
  });
});
