import type { ReactNode } from "react";
import "./facts-strip.css";

export interface Fact {
  /** Stable React key; the label is used when it is a string. */
  id?: string;
  label: ReactNode;
  value: ReactNode;
  /** A value the client does not have yet, or that does not exist: drawn quieter. */
  unknown?: boolean;
  /** The one value the rest are read against, such as the board a page is ranked by. */
  emphasis?: boolean;
}

export interface FactGroup {
  facts: Fact[];
  ariaLabel?: string;
}

/**
 * Label over value, a hairline between the values of a row, on a tinted band
 * across the panel: the training overview's facts strip (`.training-basis`),
 * for the side panels that describe one thing. Groups are separated by a rule.
 *
 * `bleed` is the panel's own horizontal padding, so the band reaches both of
 * its edges while the values stay in line with the text above and below.
 */
export function FactsStrip({
  groups,
  columns = 3,
  className = "",
}: {
  groups: FactGroup[];
  columns?: 2 | 3;
  className?: string;
}) {
  return (
    <section className={`facts-strip ${className}`.trim()}>
      {groups.map((group, groupIndex) => (
        <dl key={groupIndex} className={`facts-grid has-${columns}-columns`} aria-label={group.ariaLabel}>
          {group.facts.map((fact, factIndex) => (
            <div
              key={fact.id ?? (typeof fact.label === "string" ? fact.label : factIndex)}
              className={fact.emphasis ? "is-emphasis" : undefined}
            >
              <dt>{fact.label}</dt>
              <dd className={fact.unknown ? "is-unknown" : undefined}>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ))}
    </section>
  );
}
