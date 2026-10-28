// Pure rules for the custom-games filter dialog.
//
// The dialog holds two things in local state that are not rules yet: the value
// typed into the builder row, and an open edit of an existing rule. Both were
// discarded when the dialog closed, which is what "additional filters don't
// apply" meant: the filter had never been added. Working out what the list
// should be is arithmetic, so it lives here and is tested here rather than
// being reachable only by clicking.

import type { Game, VaultMap } from "../../../ipc/bindings";
import { mapPresentation } from "../../../shared/mapPresentation";
import type { FilterConstraint, FilterField, GameFilterRule } from "./GameFiltersModal";

/**
 * How many rules are hiding games, for the count on the toolbar's Filters
 * button: the rules while they are applied.
 *
 * A rule that is not applied hides nothing, so it is not counted: the button
 * used to count every rule, which read as filters on while "Apply filters" was
 * off. The hide switches are not counted. They sit in the toolbar beside the
 * button and show for themselves whether they are on.
 */
export function activeFilterCount(applyFilters: boolean, ruleCount: number): number {
  return applyFilters ? ruleCount : 0;
}

/**
 * A filter value as the dialog stores it.
 *
 * Surrounding quotes come off because people paste them in from the Java
 * client's filter syntax, where they were part of the grammar; here they would
 * become part of the text being matched.
 */
export function cleanFilterValue(raw: string): string {
  return raw.replace(/^["']|["']$/g, "").trim();
}

/** What the builder row or an open edit currently holds. */
export interface PendingRule {
  field: FilterField;
  constraint: FilterConstraint;
  value: string;
}

/**
 * The rule list a dialog should be left with, given what is still unsubmitted.
 *
 * Returns the same array when nothing is pending, so the caller can skip the
 * round trip entirely: `next !== rules` is the question "did anything change".
 *
 * An edit is applied before an addition, and both in one result, because the
 * dialog's `onChange` replaces the whole list: two calls would make the second
 * overwrite the first.
 */
export function rulesWithPending(
  rules: readonly GameFilterRule[],
  pendingNew: PendingRule | null,
  pendingEdit: { index: number; rule: PendingRule } | null,
): readonly GameFilterRule[] {
  let next = rules;

  const editValue = pendingEdit ? cleanFilterValue(pendingEdit.rule.value) : "";
  if (pendingEdit && editValue && rules[pendingEdit.index] !== undefined) {
    next = next.map((rule, index) =>
      index === pendingEdit.index
        ? { ...pendingEdit.rule, value: editValue }
        : rule,
    );
  }

  const addValue = pendingNew ? cleanFilterValue(pendingNew.value) : "";
  if (pendingNew && addValue) {
    next = [...next, { ...pendingNew, value: addValue }];
  }

  return next;
}

/** Whether a game matches one rule, whichever list the rule is in. */
export function matchesRule(game: Game, rule: GameFilterRule, vault: VaultMap[]) {
  if (rule.field === "rating") {
    const target = Number(rule.value);
    if (!Number.isFinite(target)) return false;
    if (rule.constraint === "above") return Number(game.averageRating) > target;
    if (rule.constraint === "below") return Number(game.averageRating) < target;
    if (rule.constraint === "notEquals") return Number(game.averageRating) !== target;
    return Number(game.averageRating) === target;
  }
  const target = rule.value.replace(/^["']|["']$/g, "").trim().toLocaleLowerCase();
  if (!target) return false;

  const testString = (val: string) => {
    const value = val.toLocaleLowerCase();
    if (rule.constraint === "starts") return value.startsWith(target);
    if (rule.constraint === "ends") return value.endsWith(target);
    if (rule.constraint === "equals") return value === target;
    if (rule.constraint === "notEquals") return value !== target;
    return value.includes(target);
  };

  if (rule.field === "title") {
    return testString(game.title);
  }
  if (rule.field === "host") {
    return testString(game.host);
  }
  if (rule.field === "map") {
    const mapDisplay = mapPresentation(vault, game.map).displayName;
    return testString(game.map) || testString(mapDisplay);
  }
  if (rule.field === "titleOrMap") {
    const mapDisplay = mapPresentation(vault, game.map).displayName;
    return testString(game.title) || testString(game.map) || testString(mapDisplay);
  }
  if (rule.field === "mod") {
    // The featured mod and every sim mod (#593): "with roguelike" means a
    // sim mod far more often than a featured one. "Does not equal" holds
    // only when none of them is the value.
    const names = [game.modName, ...Object.values(game.simMods)];
    return rule.constraint === "notEquals" ? names.every(testString) : names.some(testString);
  }
  return false;
}

/**
 * Whether a game stays in the list: one an always-show rule matches does
 * (#593, which took over the always-shown hosts of #492), any other only when
 * it passes every hide switch and rule. The search box is not an exception:
 * a search is what the player is looking for right now.
 */
export function shownDespiteFilters(
  game: Game,
  allowRules: readonly GameFilterRule[],
  vault: VaultMap[],
  passesFilters: () => boolean,
): boolean {
  return allowRules.some((rule) => matchesRule(game, rule, vault)) || passesFilters();
}
