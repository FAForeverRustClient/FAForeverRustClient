// A generated map's settings in the facts grid the detail panels share: each
// label over its value, a hairline between the values of a row. The
// generator's result pane, its enlarged preview and the Play tab's game
// preview all describe a generated map this way.

import { FactsStrip } from "../../design-system/FactsStrip";
import type { GeneratorParameter } from "../generatorPresentation";
import "./generator-facts-strip.css";

export function GeneratorFactsStrip({ rows, label, columns = 3, dense = false, className = "" }: {
  rows: GeneratorParameter[];
  /** What the grid announces itself as. */
  label: string;
  /** Four in a dialog wide enough for them, which keeps a dozen to three rows. */
  columns?: 3 | 4;
  /** Smaller type, tighter rows, and as many columns as fit: under a large
      picture, where the shared sizes made the dialog scroll. */
  dense?: boolean;
  className?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <FactsStrip
      className={`generator-facts-strip ${dense ? "is-dense " : ""}${className}`.trim()}
      columns={columns}
      groups={[
        {
          ariaLabel: label,
          facts: rows.map((row) => ({
            id: row.key,
            label: row.label,
            value: <span title={row.value}>{row.value}</span>,
          })),
        },
      ]}
    />
  );
}
