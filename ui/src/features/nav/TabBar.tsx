// Tab navigation. Renders the registry in TAB_ORDER; selecting a tab dispatches a
// Nav command and the active tab is read from state. No local routing state: the
// backend is the source of truth, so backend events can switch tabs too.

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { TAB_ORDER, TABS } from "./tabs";
import type { Tab } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import "./nav.css";

export function TabBar() {
  const active = useAppStore((s) => s.state.nav.activeTab);
  // Looked up per render rather than read from the `TABS` registry, whose
  // `label` is a fixed English string. Resolving through the hook is what makes
  // the bar follow a language change instead of being fixed at import time.
  const { t } = useTranslation();

  const select = (tab: Tab) =>
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab } } });

  const renderTab = (id: Tab) => {
    const label = t(`nav.tab.${id}.label`);
    return (
      <button
        key={id}
        className={id === active ? "tab tab-active" : "tab"}
        onClick={() => select(id)}
        aria-current={id === active ? "page" : undefined}
        aria-label={label}
        title={label}
      >
        <Icon name={TABS[id].icon} size={17} />
        <span>{label}</span>
      </button>
    );
  };

  return (
    <nav className="tabbar" aria-label={t("nav.main")}>
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
