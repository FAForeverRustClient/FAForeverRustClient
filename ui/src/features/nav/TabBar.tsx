// Tab navigation. Selecting a tab dispatches a Nav command; the active tab is
// read from state. No local routing state — the backend is the source of truth,
// which also lets backend events switch tabs (ARCHITECTURE.md, nav slice).

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import type { Tab } from "../../ipc/bindings";

const TABS: { id: Tab; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "play", label: "Play" },
];

export function TabBar() {
  const active = useAppStore((s) => s.state.nav.activeTab);

  const select = (tab: Tab) =>
    ipc.dispatch({ kind: "Nav", command: { type: "select", payload: { tab } } });

  return (
    <nav className="tabbar">
      {TABS.map((t) => (
        <button
          key={t.id}
          className={t.id === active ? "tab tab-active" : "tab"}
          onClick={() => select(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
