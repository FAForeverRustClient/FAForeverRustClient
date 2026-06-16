// Tab navigation. Renders the registry in TAB_ORDER; selecting a tab dispatches a
// Nav command and the active tab is read from state. No local routing state — the
// backend is the source of truth, so backend events can switch tabs too.

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { TAB_ORDER, TABS } from "./tabs";
import type { Tab } from "../../ipc/bindings";

export function TabBar() {
  const active = useAppStore((s) => s.state.nav.activeTab);

  const select = (tab: Tab) =>
    ipc.dispatch({ kind: "Nav", command: { type: "select", payload: { tab } } });

  return (
    <nav className="tabbar">
      {TAB_ORDER.map((id) => (
        <button
          key={id}
          className={id === active ? "tab tab-active" : "tab"}
          onClick={() => select(id)}
        >
          {TABS[id].label}
        </button>
      ))}
    </nav>
  );
}
