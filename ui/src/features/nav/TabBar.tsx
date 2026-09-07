// Tab navigation. Renders the registry in TAB_ORDER; selecting a tab dispatches a
// Nav command and the active tab is read from state. No local routing state: the
// backend is the source of truth, so backend events can switch tabs too.

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { openTabForMode, TABS, tabsForMode } from "./tabs";
import type { Tab } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import "./nav.css";

export function TabBar() {
  const mode = useAppStore((s) => s.state.auth.mode);
  // The tab on screen, which is not the selected one when the selected one is
  // not open to this session. Same projection the shell renders from.
  const active = useAppStore((s) => openTabForMode(mode, s.state.nav.activeTab));
  const tabs = tabsForMode(mode);
  // Looked up per render rather than read from the `TABS` registry, whose
  // `label` is a fixed English string. Resolving through the hook is what makes
  // the bar follow a language change instead of being fixed at import time.
  const { t } = useTranslation();

  const select = (tab: Tab) =>
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab } } });

  // Ending an offline session puts the login screen back. `logoutTest` is the
  // teardown for a session that never held a token, which is what an offline
  // one is; see `AccountSupportSettingsSection`, where the same control sits
  // under a name about leaving rather than about arriving.
  const signIn = () => ipc.send({ kind: "Auth", command: { type: "logoutTest" } });

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
        {tabs.filter((id) => id !== "contribution" && id !== "settings").map(renderTab)}
      </div>
      <div className="nav-spacer" />
      <div className="nav-group">
        {/* The way back into an account, in the corner every other session
            keeps its account controls in, and above the settings rather than
            inside them: an offline session is one somebody is trying to leave
            more often than one they are configuring. */}
        {mode === "offline" && (
          <button
            className="tab tab-sign-in"
            onClick={signIn}
            aria-label={t("auth.signIn")}
            title={t("auth.signIn")}
          >
            <Icon name="users" size={17} />
            <span>{t("auth.signIn")}</span>
          </button>
        )}
        {tabs.filter((id) => id === "contribution" || id === "settings").map(renderTab)}
      </div>
    </nav>
  );
}
