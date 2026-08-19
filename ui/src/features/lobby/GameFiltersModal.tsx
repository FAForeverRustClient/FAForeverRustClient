import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { Icon } from "../../design-system/Icon";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

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
  onClose: () => void;
}

export function GameFiltersModal({ rules, applyFilters, onApplyFiltersChange, onChange, onClose }: Props) {
  const { t } = useTranslation();
  const [field, setField] = useState<FilterField>("map");
  const [constraint, setConstraint] = useState<FilterConstraint>("contains");
  const [value, setValue] = useState("");

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editField, setEditField] = useState<FilterField>("map");
  const [editConstraint, setEditConstraint] = useState<FilterConstraint>("contains");
  const [editValue, setEditValue] = useState("");

  const add = () => {
    const clean = value.replace(/^["']|["']$/g, "").trim();
    if (!clean) return;
    onChange([...rules, { field, constraint, value: clean }]);
    setValue("");
  };

  const startEdit = (index: number, rule: GameFilterRule) => {
    setEditingIndex(index);
    setEditField(rule.field);
    setEditConstraint(rule.constraint);
    setEditValue(rule.value);
  };

  const saveEdit = () => {
    if (editingIndex === null) return;
    const clean = editValue.replace(/^["']|["']$/g, "").trim();
    if (!clean) return;
    const updated = rules.map((r, i) =>
      i === editingIndex
        ? { field: editField, constraint: editConstraint, value: clean }
        : r,
    );
    onChange(updated);
    setEditingIndex(null);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
  };

  return (
    <Modal className="game-filters-dialog" onClose={onClose}>
      <div className="play-dialog-head">
        <div>
          <h2>{t("lobby.filters.title")}</h2>
          <p>{t("lobby.filters.subtitle")}</p>
        </div>
        <label className="toolbar-check filter-dialog-toggle">
          <input
            type="checkbox"
            checked={applyFilters}
            onChange={(event) => onApplyFiltersChange(event.target.checked)}
          />
          {t("lobby.toolbar.applyFilters")}
        </label>
      </div>

      <div className="filter-grid-row filter-rule-builder">
        <select
          value={field}
          onChange={(event) => setField(event.target.value as FilterField)}
          aria-label={t("lobby.filters.fieldAria")}
        >
          <option value="map">{t("lobby.filters.field.map")}</option>
          <option value="title">{t("lobby.filters.field.title")}</option>
          <option value="titleOrMap">{t("lobby.filters.field.titleOrMap")}</option>
          <option value="host">{t("lobby.filters.field.host")}</option>
          <option value="mod">{t("lobby.filters.field.mod")}</option>
          <option value="rating">{t("lobby.filters.field.rating")}</option>
        </select>
        <select
          value={constraint}
          onChange={(event) => setConstraint(event.target.value as FilterConstraint)}
          aria-label={t("lobby.filters.constraintAria")}
        >
          <option value="contains">{t("lobby.filters.constraint.contains")}</option>
          <option value="starts">{t("lobby.filters.constraint.starts")}</option>
          <option value="ends">{t("lobby.filters.constraint.ends")}</option>
          <option value="equals">{t("lobby.filters.constraint.equals")}</option>
          <option value="notEquals">{t("lobby.filters.constraint.notEquals")}</option>
          <option value="above">{t("lobby.filters.constraint.above")}</option>
          <option value="below">{t("lobby.filters.constraint.below")}</option>
        </select>
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
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
          <p className="play-empty">{t("lobby.filters.empty")}</p>
        ) : (
          rules.map((rule, index) =>
            editingIndex === index ? (
              <div className="filter-grid-row filter-rule is-editing" key={index}>
                <select
                  value={editField}
                  onChange={(e) => setEditField(e.target.value as FilterField)}
                  aria-label={t("lobby.filters.fieldAria")}
                >
                  <option value="map">{t("lobby.filters.field.map")}</option>
                  <option value="title">{t("lobby.filters.field.title")}</option>
                  <option value="titleOrMap">{t("lobby.filters.field.titleOrMap")}</option>
                  <option value="host">{t("lobby.filters.field.host")}</option>
                  <option value="mod">{t("lobby.filters.field.mod")}</option>
                  <option value="rating">{t("lobby.filters.field.rating")}</option>
                </select>
                <select
                  value={editConstraint}
                  onChange={(e) => setEditConstraint(e.target.value as FilterConstraint)}
                  aria-label={t("lobby.filters.constraintAria")}
                >
                  <option value="contains">{t("lobby.filters.constraint.contains")}</option>
                  <option value="starts">{t("lobby.filters.constraint.starts")}</option>
                  <option value="ends">{t("lobby.filters.constraint.ends")}</option>
                  <option value="equals">{t("lobby.filters.constraint.equals")}</option>
                  <option value="notEquals">{t("lobby.filters.constraint.notEquals")}</option>
                  <option value="above">{t("lobby.filters.constraint.above")}</option>
                  <option value="below">{t("lobby.filters.constraint.below")}</option>
                </select>
                <input
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") saveEdit();
                    if (e.key === "Escape") cancelEdit();
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
                    onClick={cancelEdit}
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
                onDoubleClick={() => startEdit(index, rule)}
              >
                <span className="filter-rule-cell">{t(FIELD_LABELS[rule.field])}</span>
                <span className="filter-rule-cell muted">{t(CONSTRAINT_LABELS[rule.constraint])}</span>
                <span className="filter-rule-cell filter-rule-val">
                  <strong>{rule.value}</strong>
                </span>
                <div className="filter-rule-actions">
                  <button
                    type="button"
                    onClick={() => startEdit(index, rule)}
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
    </Modal>
  );
}
