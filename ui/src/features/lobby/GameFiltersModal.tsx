import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { Icon } from "../../design-system/Icon";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

export type FilterField = "title" | "host" | "map" | "mod" | "rating";
export type FilterConstraint = "contains" | "starts" | "ends" | "equals" | "notEquals" | "above" | "below";

// Field and constraint captions, shared by the pickers and by the rendered
// rule list so a saved rule reads exactly as it was entered.
const FIELD_LABELS = {
  title: "lobby.filters.field.title",
  host: "lobby.filters.field.host",
  map: "lobby.filters.field.map",
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
  onChange: (rules: GameFilterRule[]) => void;
  onClose: () => void;
}

export function GameFiltersModal({ rules, onChange, onClose }: Props) {
  const { t } = useTranslation();
  const [field, setField] = useState<FilterField>("title");
  const [constraint, setConstraint] = useState<FilterConstraint>("contains");
  const [value, setValue] = useState("");

  const add = () => {
    const clean = value.trim();
    if (!clean) return;
    onChange([...rules, { field, constraint, value: clean }]);
    setValue("");
  };

  return (
    <Modal onClose={onClose}>
      <div className="play-dialog-head">
        <div>
          <h2>{t("lobby.filters.title")}</h2>
          <p>{t("lobby.filters.subtitle")}</p>
        </div>
      </div>

      <div className="filter-rule-builder">
        <select value={field} onChange={(event) => setField(event.target.value as FilterField)} aria-label={t("lobby.filters.fieldAria")}>
          <option value="title">{t("lobby.filters.field.title")}</option>
          <option value="host">{t("lobby.filters.field.host")}</option>
          <option value="map">{t("lobby.filters.field.map")}</option>
          <option value="mod">{t("lobby.filters.field.mod")}</option>
          <option value="rating">{t("lobby.filters.field.rating")}</option>
        </select>
        <select value={constraint} onChange={(event) => setConstraint(event.target.value as FilterConstraint)} aria-label={t("lobby.filters.constraintAria")}>
          <option value="contains">{t("lobby.filters.constraint.contains")}</option>
          <option value="starts">{t("lobby.filters.constraint.starts")}</option>
          <option value="ends">{t("lobby.filters.constraint.ends")}</option>
          <option value="equals">{t("lobby.filters.constraint.equals")}</option>
          <option value="notEquals">{t("lobby.filters.constraint.notEquals")}</option>
          <option value="above">{t("lobby.filters.constraint.above")}</option>
          <option value="below">{t("lobby.filters.constraint.below")}</option>
        </select>
        <input value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => event.key === "Enter" && add()} placeholder={t("lobby.filters.valuePlaceholder")} aria-label={t("lobby.filters.valueAria")} />
        <Button variant="primary" onClick={add}><Icon name="plus" size={15} /> {t("lobby.filters.addRule")}</Button>
      </div>

      <div className="filter-rule-list surface">
        {rules.length === 0 ? (
          <p className="play-empty">{t("lobby.filters.empty")}</p>
        ) : rules.map((rule, index) => (
          <div className="filter-rule" key={`${rule.field}-${rule.constraint}-${rule.value}-${index}`}>
            <span>{t(FIELD_LABELS[rule.field])}</span>
            <span className="muted">{t(CONSTRAINT_LABELS[rule.constraint])}</span>
            <strong>{rule.value}</strong>
            <button onClick={() => onChange(rules.filter((_, ruleIndex) => ruleIndex !== index))} aria-label={t("lobby.filters.removeRuleAria", { value: rule.value })} title={t("lobby.filters.removeRule")}>
              <Icon name="close" size={15} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
