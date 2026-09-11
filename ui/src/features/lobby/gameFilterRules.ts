// Pure rules for the custom-games filter dialog.
//
// The dialog holds two things in local state that are not rules yet: the value
// typed into the builder row, and an open edit of an existing rule. Both were
// discarded when the dialog closed, which is what "additional filters don't
// apply" meant: the filter had never been added. Working out what the list
// should be is arithmetic, so it lives here and is tested here rather than
// being reachable only by clicking.

import type { FilterConstraint, FilterField, GameFilterRule } from "./GameFiltersModal";

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
