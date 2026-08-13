// Tab navigation. Renders the registry in TAB_ORDER; selecting a tab dispatches a
// Nav command and the active tab is read from state. No local routing state: the
// backend is the source of truth, so backend events can switch tabs too.

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { TAB_ORDER, TABS } from "./tabs";
import type { Tab } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import "./nav.css";

export function TabBar() {
  const active = useAppStore((s) => s.state.nav.activeTab);

  const select = (tab: Tab) =>
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab } } });

  const renderTab = (id: Tab) => (
    <button
      key={id}
      className={id === active ? "tab tab-active" : "tab"}
      onClick={() => select(id)}
      aria-current={id === active ? "page" : undefined}
      aria-label={TABS[id].label}
      title={TABS[id].label}
    >
      <Icon name={TABS[id].icon} size={17} />
      <span>{TABS[id].label}</span>
    </button>
  );

  return (
    <nav className="tabbar" aria-label="Main navigation">
      <div className="nav-group">
        {TAB_ORDER.filter((id) => id !== "contribution" && id !== "settings").map(renderTab)}
      </div>
      <div className="nav-spacer" />
      <div className="nav-group">
        {TAB_ORDER.filter((id) => id === "contribution" || id === "settings").map(renderTab)}
      </div>
    </nav>
  );
}
