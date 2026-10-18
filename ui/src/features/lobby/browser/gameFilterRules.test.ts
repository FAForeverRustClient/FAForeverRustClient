import { describe, expect, it } from "vitest";

import type { Game } from "../../../ipc/bindings";
import {
  activeFilterCount,
  cleanFilterValue,
  matchesRule,
  rulesWithPending,
  shownDespiteFilters,
} from "./gameFilterRules";
import type { GameFilterRule } from "./GameFiltersModal";

describe("activeFilterCount", () => {
  it("counts the rules only while they are applied", () => {
    // A rule that is not applied hides nothing.
    expect(activeFilterCount(true, 3)).toBe(3);
    expect(activeFilterCount(false, 3)).toBe(0);
    expect(activeFilterCount(true, 0)).toBe(0);
  });
});

const rule = (value: string): GameFilterRule => ({
  field: "map",
  constraint: "contains",
  value,
});

describe("cleanFilterValue", () => {
  it("strips the quotes people paste in from the Java client's syntax", () => {
    expect(cleanFilterValue('"seton"')).toBe("seton");
    expect(cleanFilterValue("'astro'")).toBe("astro");
    expect(cleanFilterValue("  dual gap  ")).toBe("dual gap");
  });

  it("leaves a quote in the middle alone, because it is part of the name", () => {
    expect(cleanFilterValue("seton's clutch")).toBe("seton's clutch");
  });
});

describe("rulesWithPending", () => {
  it("keeps a value typed into the builder but never added", () => {
    // The reported bug: fill the row in, tick Apply filters, close, and nothing
    // is filtered, because the rule was only ever in the dialog's local state.
    const next = rulesWithPending([], { field: "map", constraint: "contains", value: "seton" }, null);

    expect(next).toEqual([rule("seton")]);
  });

  it("returns the very same array when nothing is pending", () => {
    // Identity, not equality: the caller uses it to decide whether to dispatch
    // at all, so closing a dialog you only looked at must cost nothing.
    const rules = [rule("astro")];
    expect(rulesWithPending(rules, { field: "map", constraint: "contains", value: "" }, null)).toBe(
      rules,
    );
    expect(rulesWithPending(rules, null, null)).toBe(rules);
  });

  it("treats a builder row holding only whitespace as empty", () => {
    const rules = [rule("astro")];
    expect(rulesWithPending(rules, { field: "map", constraint: "contains", value: "   " }, null)).toBe(
      rules,
    );
  });

  it("keeps an edit that was never confirmed", () => {
    const next = rulesWithPending([rule("astro"), rule("gap")], null, {
      index: 1,
      rule: { field: "host", constraint: "equals", value: "Vindex" },
    });

    expect(next).toEqual([rule("astro"), { field: "host", constraint: "equals", value: "Vindex" }]);
  });

  it("applies an edit and an addition together, never one replacing the other", () => {
    // `onChange` replaces the whole list, so sending the edit and the addition
    // as two calls would lose the first.
    const next = rulesWithPending([rule("astro")], { field: "map", constraint: "ends", value: "gap" }, {
      index: 0,
      rule: { field: "map", constraint: "starts", value: "astro crater" },
    });

    expect(next).toEqual([
      { field: "map", constraint: "starts", value: "astro crater" },
      { field: "map", constraint: "ends", value: "gap" },
    ]);
  });

  it("drops an edit emptied out rather than deleting the rule", () => {
    // Clearing the field and closing is not a delete: there is a remove button
    // for that, and silently losing a rule is worse than keeping it.
    const rules = [rule("astro")];
    expect(
      rulesWithPending(rules, null, {
        index: 0,
        rule: { field: "map", constraint: "contains", value: "" },
      }),
    ).toBe(rules);
  });

  it("ignores an edit index that no longer exists", () => {
    const rules = [rule("astro")];
    expect(
      rulesWithPending(rules, null, {
        index: 7,
        rule: { field: "map", constraint: "contains", value: "gone" },
      }),
    ).toBe(rules);
  });

  it("strips quotes from what it keeps, the way Add rule does", () => {
    const next = rulesWithPending([], { field: "title", constraint: "contains", value: '"test"' }, null);

    expect(next).toEqual([{ field: "title", constraint: "contains", value: "test" }]);
  });
});

function game(overrides: Partial<Game> = {}): Game {
  return {
    id: 1,
    title: "Come play",
    host: "Nuggets",
    players: 3,
    maxPlayers: 8,
    map: "Setons Clutch",
    modName: "faf",
    averageRating: 1200,
    ratingType: "global",
    passwordProtected: false,
    visibility: "public",
    gameType: "custom",
    launchedAt: null,
    hostedAt: null,
    ratingMin: null,
    ratingMax: null,
    enforceRatingRange: false,
    teams: { "1": ["Nuggets"] },
    simMods: {},
    ...overrides,
  };
}

describe("the mod field (#593)", () => {
  const modded = game({ simMods: { "a1b2": "Roguelike FAF" } });

  it("matches a sim mod as well as the featured mod", () => {
    expect(matchesRule(modded, { field: "mod", constraint: "contains", value: "roguelike" }, [])).toBe(true);
    expect(matchesRule(modded, { field: "mod", constraint: "equals", value: "faf" }, [])).toBe(true);
    expect(matchesRule(game(), { field: "mod", constraint: "contains", value: "roguelike" }, [])).toBe(false);
  });

  it("does not equal only when none of the game's mods is the value", () => {
    const rule: GameFilterRule = { field: "mod", constraint: "notEquals", value: "roguelike faf" };
    expect(matchesRule(modded, rule, [])).toBe(false);
    expect(matchesRule(game(), rule, [])).toBe(true);
  });
});

describe("games always shown (#593)", () => {
  const hidden = () => false;

  it("keeps a game an always-show rule matches, whatever would hide it", () => {
    const rules: GameFilterRule[] = [{ field: "mod", constraint: "contains", value: "roguelike" }];
    expect(shownDespiteFilters(game({ simMods: { x: "Roguelike" } }), rules, [], hidden)).toBe(true);
    expect(shownDespiteFilters(game(), rules, [], hidden)).toBe(false);
    expect(shownDespiteFilters(game(), rules, [], () => true)).toBe(true);
  });

  it("matches a host in any case, as the hosts list it replaced did", () => {
    const rules: GameFilterRule[] = [{ field: "host", constraint: "equals", value: "nuggets" }];
    expect(shownDespiteFilters(game({ host: "NUGGETS" }), rules, [], hidden)).toBe(true);
    expect(shownDespiteFilters(game({ host: "Zed" }), rules, [], hidden)).toBe(false);
  });
});
