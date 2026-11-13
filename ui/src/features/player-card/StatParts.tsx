// The shapes the profile's history tabs share (Results, Maps, Statistics):
// the figure tiles across the top, the card a table or chart sits in, the
// win, draw and loss bar, and a rating change in its colour.
//
// One set rather than one per tab, and in the Overview's own language (the
// queue tiles, the eyebrow headings, the count chip), so the tabs read as parts
// of the same card instead of three reports that happen to share a window.

import type { CSSProperties, ReactNode } from "react";
import { Icon } from "../../design-system/Icon";

export interface StatTile {
  /** Also the React key: a tile's label is unique within its row. */
  label: string;
  value: ReactNode;
  /** One quiet line of context under the value. */
  detail?: ReactNode;
  /** The detail's full text, for a detail that may be cut short. */
  detailTitle?: string;
  /** The record the value is made of, drawn as a bar under it. */
  record?: Record3;
  /** A value that is nothing yet: drawn quieter, like an unknown fact. */
  empty?: boolean;
}

/**
 * The figures a tab opens on, one tile each, `columns` to a row. The tile is
 * the Overview's queue tile without its foot: an uppercase label, the number
 * large, and what it is made of under it.
 */
export function StatTiles({ tiles, columns }: { tiles: StatTile[]; columns: number }) {
  return (
    <dl className="player-stat-tiles" style={{ "--stat-columns": columns } as CSSProperties}>
      {tiles.map((tile) => (
        <div key={tile.label} className="player-stat-tile surface-panel">
          <dt>{tile.label}</dt>
          <dd className={tile.empty ? "player-stat-value is-empty" : "player-stat-value"}>{tile.value}</dd>
          {tile.record && (
            <dd className="player-stat-bar">
              <RecordBar {...tile.record} />
            </dd>
          )}
          {tile.detail && (
            <dd className="player-stat-detail" title={tile.detailTitle}>
              {tile.detail}
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/**
 * A table or chart under an eyebrow heading, the Overview card's head: the
 * title, an optional count beside it and the card's own controls at the far
 * end. A table as the card's last child runs to its edges (see the CSS).
 * `footnote` is what the reader is owed about the card's numbers.
 */
export function TabCard({
  title,
  count,
  actions,
  footnote,
  children,
  className = "",
}: {
  title: ReactNode;
  count?: ReactNode;
  actions?: ReactNode;
  footnote?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`player-tab-card surface-panel ${className}`.trim()}>
      <header className="player-tab-card-head">
        <h3>
          {title}
          {count !== undefined && <span className="player-overview-count">{count}</span>}
        </h3>
        {actions && <div className="player-tab-card-actions">{actions}</div>}
      </header>
      {children}
      {footnote && <CardFootnote>{footnote}</CardFootnote>}
    </section>
  );
}

/**
 * A note about a card's numbers (what was left out, what a count includes),
 * as a band across the card's foot with the info mark: the one place such a
 * sentence goes, so it reads as part of what it explains instead of a loose
 * line between two blocks.
 */
export function CardFootnote({ children }: { children: ReactNode }) {
  return (
    <p className="player-tab-card-footnote">
      <Icon name="info" size={13} />
      <span>{children}</span>
    </p>
  );
}

export interface Record3 {
  wins: number;
  losses: number;
  draws: number;
}

/**
 * Wins, draws and losses as one bar, each part as long as its count: the
 * shape of a record, the numbers beside it doing the reading. Hidden from
 * screen readers, which are given those numbers instead.
 */
export function RecordBar({ wins, losses, draws }: Record3) {
  const empty = wins + losses + draws === 0;
  return (
    <span className={empty ? "player-record-bar is-empty" : "player-record-bar"} aria-hidden="true">
      {wins > 0 && <span className="is-win" style={{ flexGrow: wins }} />}
      {draws > 0 && <span className="is-draw" style={{ flexGrow: draws }} />}
      {losses > 0 && <span className="is-loss" style={{ flexGrow: losses }} />}
    </span>
  );
}

/** `text` in the colour of the change it reads: a gain green, a loss red, none plain. */
export function Signed({ value, children }: { value: number; children: ReactNode }) {
  const tone = value > 0 ? " is-up" : value < 0 ? " is-down" : "";
  return <span className={`player-signed${tone}`}>{children}</span>;
}

/**
 * A record as three numbers, each in its outcome's colour, between the
 * separators the column heading uses. The text reads the same as before.
 */
export function RecordText({ wins, losses, draws, separator, format }: Record3 & {
  separator: string;
  format: (value: number) => string;
}) {
  return (
    <span className="player-record-text">
      <span className="is-win">{format(wins)}</span>
      {separator}
      <span className="is-loss">{format(losses)}</span>
      {separator}
      <span className="is-draw">{format(draws)}</span>
    </span>
  );
}
