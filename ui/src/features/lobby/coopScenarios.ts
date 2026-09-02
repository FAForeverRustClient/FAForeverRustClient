// How the co-op campaign list is ordered and labelled.
//
// Both the co-op tab's campaign dropdown and the host dialog's campaign column
// showed the same list in the same wrong order, each with its own copy of the
// sort, so this is one module they share.

import type { CoopScenario } from "../../ipc/bindings";

/**
 * Which game a campaign came from, and the primary sort key.
 *
 * The list has to open with the three vanilla campaigns, then the Forged
 * Alliance one, then whatever the community has built. Sorting by faction
 * first - what both views did - interleaves those groups instead: the
 * community Seraphim campaign has a real faction and so jumped ahead of the
 * Forged Alliance campaign, whose faction is `custom` because the player picks
 * one.
 */
const CATEGORY_ORDER: Record<CoopScenario["category"], number> = {
  sc: 0,
  scfa: 1,
  custom: 2,
};

const FACTION_ORDER: Record<CoopScenario["faction"], number> = {
  uef: 0,
  cybran: 1,
  aeon: 2,
  seraphim: 3,
  custom: 4,
};

export function factionRank(faction: CoopScenario["faction"]): number {
  return FACTION_ORDER[faction] ?? FACTION_ORDER.custom;
}

function categoryRank(category: CoopScenario["category"]): number {
  return CATEGORY_ORDER[category] ?? CATEGORY_ORDER.custom;
}

/**
 * Campaigns in the order the co-op tab should present them.
 *
 * Within a group the API's own `order` decides - that column exists to be the
 * display order, and the official client renders the list the API hands it
 * without sorting at all. Faction and name only break ties.
 */
export function sortCoopScenarios<T extends CoopScenario>(scenarios: readonly T[]): T[] {
  return [...scenarios].sort(
    (a, b) =>
      categoryRank(a.category) - categoryRank(b.category) ||
      a.order - b.order ||
      factionRank(a.faction) - factionRank(b.faction) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * What the badge next to a campaign's name says.
 *
 * Normally the faction, which is what the badge is for. A campaign the player
 * picks a faction for has none, and printing the raw value labelled the Forged
 * Alliance campaign - a retail campaign shipped with the game - "CUSTOM",
 * alongside genuine community work. The category is what separates those two.
 */
export function scenarioBadge(scenario: CoopScenario): "uef" | "cybran" | "aeon" | "seraphim" | "official" | "custom" {
  if (scenario.faction !== "custom") return scenario.faction;
  return scenario.category === "custom" ? "custom" : "official";
}
