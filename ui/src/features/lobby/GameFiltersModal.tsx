import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { Icon } from "../../design-system/Icon";

export type FilterField = "title" | "host" | "map" | "mod" | "rating";
export type FilterConstraint = "contains" | "starts" | "ends" | "equals" | "notEquals" | "above" | "below";

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
          <h2>Manage game filters</h2>
          <p>Games matching any rule are excluded from the custom-games list.</p>
        </div>
      </div>

      <div className="filter-rule-builder">
        <select value={field} onChange={(event) => setField(event.target.value as FilterField)} aria-label="Filter field">
          <option value="title">Game title</option>
          <option value="host">Host name</option>
          <option value="map">Map name</option>
          <option value="mod">Featured mod</option>
          <option value="rating">Average rating</option>
        </select>
        <select value={constraint} onChange={(event) => setConstraint(event.target.value as FilterConstraint)} aria-label="Filter constraint">
          <option value="contains">contains</option>
          <option value="starts">starts with</option>
          <option value="ends">ends with</option>
          <option value="equals">equals</option>
          <option value="notEquals">does not equal</option>
          <option value="above">is above</option>
          <option value="below">is below</option>
        </select>
        <input value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => event.key === "Enter" && add()} placeholder="Value" aria-label="Filter value" />
        <Button variant="primary" onClick={add}><Icon name="plus" size={15} /> Add rule</Button>
      </div>

      <div className="filter-rule-list surface">
        {rules.length === 0 ? (
          <p className="play-empty">No exclusion rules yet.</p>
        ) : rules.map((rule, index) => (
          <div className="filter-rule" key={`${rule.field}-${rule.constraint}-${rule.value}-${index}`}>
            <span>{rule.field}</span>
            <span className="muted">{rule.constraint}</span>
            <strong>{rule.value}</strong>
            <button onClick={() => onChange(rules.filter((_, ruleIndex) => ruleIndex !== index))} aria-label={`Remove ${rule.value} filter`} title="Remove filter">
              <Icon name="close" size={15} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
