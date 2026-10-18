import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import { Icon } from "../../../design-system/Icon";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";
import { cleanFilterValue, rulesWithPending, type PendingRule } from "./gameFilterRules";

export type FilterField = "titleOrMap" | "title" | "map" | "host" | "mod" | "rating";
export type FilterConstraint = "contains" | "starts" | "ends" | "equals" | "notEquals" | "above" | "below";

// Field and constraint captions, shared by the pickers and by the rendered
// rule list so a saved rule reads exactly as it was entered.
const FIELD_LABELS = {
  titleOrMap: "lobby.filters.field.titleOrMap",
  title: "lobby.filters.field.title",
  map: "lobby.filters.field.map",
  host: "lobby.filters.field.host",
  mod: "lobby.filters.field.mod",
  rating: "lobby.filters.field.rating",
} as const satisfies Record<FilterField, MessageKey>;

const CONSTRAINT_LABELS = {
  contains: "lobby.filters.constraint.contains",
  starts: "lobby.filters.constraint.starts",
  ends: "lobby.filters.constraint.ends",
  equals: "lobby.filters.constraint.equals",
  notEquals: "lobby.filters.constraint.notEquals",
  above: "lobby.filters.constraint.above",
  below: "lobby.filters.constraint.below",
} as const satisfies Record<FilterConstraint, MessageKey>;

// In the order the pickers offer them.
const FIELDS: FilterField[] = ["map", "title", "titleOrMap", "host", "mod", "rating"];
const CONSTRAINTS: FilterConstraint[] = ["contains", "starts", "ends", "equals", "notEquals", "above", "below"];

export interface GameFilterRule {
  field: FilterField;
  constraint: FilterConstraint;
  value: string;
}

interface Props {
  rules: GameFilterRule[];
  applyFilters: boolean;
  onApplyFiltersChange: (apply: boolean) => void;
  onChange: (rules: GameFilterRule[]) => void;
  /**
   * The other direction: games these match stay in the list whatever the
   * hide switches and the rules above say (#593). They took over the hosts
   * always shown (#492), as `Host equals` rules.
   */
  allowRules: GameFilterRule[];
  onAllowChange: (rules: GameFilterRule[]) => void;
  onClose: () => void;
}

/**
 * What one rule list's builder row and open edit hold, before either is a
 * rule. Held by the dialog rather than by the list, because closing the
 * dialog keeps whatever is typed in either list (see `closeKeepingPending`).
 */
interface RuleDraft {
  pending: PendingRule;
  setPending: (pending: PendingRule) => void;
  editing: { index: number; rule: PendingRule } | null;
  setEditing: (editing: { index: number; rule: PendingRule } | null) => void;
}

function useRuleDraft(): RuleDraft {
  const [pending, setPending] = useState<PendingRule>({ field: "map", constraint: "contains", value: "" });
  const [editing, setEditing] = useState<{ index: number; rule: PendingRule } | null>(null);
  return { pending, setPending, editing, setEditing };
}

function FieldPickers({ rule, onChange }: { rule: PendingRule; onChange: (rule: PendingRule) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <select
        value={rule.field}
        onChange={(event) => onChange({ ...rule, field: event.target.value as FilterField })}
        aria-label={t("lobby.filters.fieldAria")}
      >
        {FIELDS.map((field) => <option key={field} value={field}>{t(FIELD_LABELS[field])}</option>)}
      </select>
      <select
        value={rule.constraint}
        onChange={(event) => onChange({ ...rule, constraint: event.target.value as FilterConstraint })}
        aria-label={t("lobby.filters.constraintAria")}
      >
        {CONSTRAINTS.map((constraint) => (
          <option key={constraint} value={constraint}>{t(CONSTRAINT_LABELS[constraint])}</option>
        ))}
      </select>
    </>
  );
}

/**
 * One list of rules with its builder row: the rules that hide games, or the
 * ones that keep games shown. The same builder for both, so a rule reads and
 * is made the same way whichever way it points.
 */
function RuleList({
  rules,
  onChange,
  draft,
  verb,
  empty,
}: {
  rules: GameFilterRule[];
  onChange: (rules: GameFilterRule[]) => void;
  draft: RuleDraft;
  /** The rule's direction, on the rule itself: "Hide" or "Show". */
  verb: MessageKey;
  empty: MessageKey;
}) {
  const { t } = useTranslation();
  const { pending, setPending, editing, setEditing } = draft;

  const add = () => {
    const cleaned = cleanFilterValue(pending.value);
    if (!cleaned) return;
    onChange([...rules, { ...pending, value: cleaned }]);
    setPending({ ...pending, value: "" });
  };

  const saveEdit = () => {
    if (!editing) return;
    const cleaned = cleanFilterValue(editing.rule.value);
    if (!cleaned) return;
    onChange(rules.map((rule, index) => (index === editing.index ? { ...editing.rule, value: cleaned } : rule)));
    setEditing(null);
  };

  return (
    <>
      <div className="filter-grid-row filter-rule-builder">
        <FieldPickers rule={pending} onChange={setPending} />
        <input
          value={pending.value}
          onChange={(event) => setPending({ ...pending, value: event.target.value })}
          onKeyDown={(event) => event.key === "Enter" && add()}
          placeholder={t("lobby.filters.valuePlaceholder")}
          aria-label={t("lobby.filters.valueAria")}
        />
        <Button variant="primary" onClick={add} className="filter-add-btn">
          <Icon name="plus" size={15} /> {t("lobby.filters.addRule")}
        </Button>
      </div>

      <div className="filter-rule-list surface">
        {rules.length === 0 ? (
          <p className="play-empty">{t(empty)}</p>
        ) : (
          rules.map((rule, index) =>
            editing?.index === index ? (
              <div className="filter-grid-row filter-rule is-editing" key={index}>
                <FieldPickers rule={editing.rule} onChange={(next) => setEditing({ index, rule: next })} />
                <input
                  value={editing.rule.value}
                  onChange={(e) => setEditing({ index, rule: { ...editing.rule, value: e.target.value } })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit();
                    if (e.key === "Escape") {
                      // Abandons the edit only; the dialog stays open.
                      e.stopPropagation();
                      setEditing(null);
                    }
                  }}
                  placeholder={t("lobby.filters.valuePlaceholder")}
                  aria-label={t("lobby.filters.valueAria")}
                  autoFocus
                />
                <div className="filter-rule-actions">
                  <button
                    type="button"
                    onClick={saveEdit}
                    aria-label={t("lobby.filters.saveRule")}
                    title={t("lobby.filters.saveRule")}
                    className="filter-rule-save"
                  >
                    <Icon name="check" size={15} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    aria-label={t("lobby.filters.cancelEdit")}
                    title={t("lobby.filters.cancelEdit")}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              </div>
            ) : (
              <div
                className="filter-grid-row filter-rule"
                key={`${rule.field}-${rule.constraint}-${rule.value}-${index}`}
                onDoubleClick={() => setEditing({ index, rule })}
              >
                {/* The rule's direction, on the rule itself. It is in the
                    section's heading too, and a heading is not where somebody
                    reads it: both reports of this filter were somebody
                    expecting a match to *show* a lobby. Four columns, so it
                    rides along with the field rather than taking a fifth. */}
                <span className="filter-rule-cell">
                  <span className="filter-rule-verb">{t(verb)}</span>{" "}
                  {t(FIELD_LABELS[rule.field])}
                </span>
                <span className="filter-rule-cell muted">{t(CONSTRAINT_LABELS[rule.constraint])}</span>
                <span className="filter-rule-cell filter-rule-val">
                  <strong>{rule.value}</strong>
                </span>
                <div className="filter-rule-actions">
                  <button
                    type="button"
                    onClick={() => setEditing({ index, rule })}
                    aria-label={t("lobby.filters.editRule")}
                    title={t("lobby.filters.editRule")}
                  >
                    <Icon name="edit" size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange(rules.filter((_, ruleIndex) => ruleIndex !== index))}
                    aria-label={t("lobby.filters.removeRuleAria", { value: rule.value })}
                    title={t("lobby.filters.removeRule")}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              </div>
            ),
          )
        )}
      </div>
    </>
  );
}

export function GameFiltersModal({
  rules,
  applyFilters,
  onApplyFiltersChange,
  onChange,
  allowRules,
  onAllowChange,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const hideDraft = useRuleDraft();
  const allowDraft = useRuleDraft();

  /**
   * Close, keeping whatever was typed.
   *
   * The builder row held a typed value in local state until "Add rule" was
   * pressed, and closing the dialog threw it away. So filling the row in,
   * ticking "Apply filters" and closing did nothing at all, which is the
   * reported "additional filters don't apply": the filter had never been added.
   * An open edit is the same mistake in the other direction. Both lists, each
   * with one `onChange`, because it replaces the whole list.
   */
  const closeKeepingPending = () => {
    const nextHide = rulesWithPending(rules, hideDraft.pending, hideDraft.editing);
    if (nextHide !== rules) onChange(nextHide as GameFilterRule[]);
    const nextAllow = rulesWithPending(allowRules, allowDraft.pending, allowDraft.editing);
    if (nextAllow !== allowRules) onAllowChange(nextAllow as GameFilterRule[]);
    onClose();
  };

  return (
    <Modal className="game-filters-dialog" onClose={closeKeepingPending}>
      <div className="play-dialog-head">
        <div>
          <h2>{t("lobby.filters.title")}</h2>
          <p>{t("lobby.filters.subtitle")}</p>
        </div>
        <label
          className="toolbar-check filter-dialog-toggle"
          title={t("lobby.toolbar.applyFiltersHint")}
        >
          <input
            type="checkbox"
            checked={applyFilters}
            onChange={(event) => onApplyFiltersChange(event.target.checked)}
          />
          {t("lobby.toolbar.applyFilters")}
        </label>
      </div>

      <RuleList rules={rules} onChange={onChange} draft={hideDraft} verb="lobby.filters.hide" empty="lobby.filters.empty" />

      {/* The other direction from the rules above: not what to hide, but
          which games to keep whatever is hidden. Its own section with the
          same builder, so a rule here is never read as one more exclusion. */}
      <section className="filter-whitelist" aria-labelledby="filter-allow-title">
        <div className="filter-whitelist-head">
          <h3 id="filter-allow-title">{t("lobby.filters.allow.title")}</h3>
          <p>{t("lobby.filters.allow.hint")}</p>
        </div>
        <RuleList
          rules={allowRules}
          onChange={onAllowChange}
          draft={allowDraft}
          verb="lobby.filters.show"
          empty="lobby.filters.allow.empty"
        />
      </section>
    </Modal>
  );
}
