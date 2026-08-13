import type { ReactNode } from "react";
import "./section-tabs.css";

export interface SectionTab<T extends string | number> {
  id: T;
  label: ReactNode;
  count?: number;
}

interface Props<T extends string | number> {
  active: T | null;
  ariaLabel: string;
  className?: string;
  items: readonly SectionTab<T>[];
  onChange: (id: T) => void;
}

/** Compact underline navigation for switching peer views inside a feature. */
export function SectionTabs<T extends string | number>({
  active,
  ariaLabel,
  className = "",
  items,
  onChange,
}: Props<T>) {
  return (
    <nav className={`section-tabs ${className}`.trim()} role="tablist" aria-label={ariaLabel}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={active === item.id}
          className={active === item.id ? "active" : undefined}
          onClick={() => onChange(item.id)}
        >
          <span className="section-tab-label">{item.label}</span>
          {item.count !== undefined && <span className="section-tab-count">{item.count}</span>}
        </button>
      ))}
    </nav>
  );
}
