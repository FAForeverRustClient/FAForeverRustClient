// Panel primitive: a dockable, collapsible side panel (as opposed to Modal's
// backdrop overlay). Used for the Custom Games detail view: persistent beside
// the tile grid rather than blocking it.

import type { ReactNode } from "react";

interface PanelProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}

export function Panel({ open, onClose, children }: PanelProps) {
  if (!open) return null;
  return (
    <aside className="side-panel">
      <button className="side-panel-close" onClick={onClose} aria-label="Close">
        ×
      </button>
      {children}
    </aside>
  );
}
