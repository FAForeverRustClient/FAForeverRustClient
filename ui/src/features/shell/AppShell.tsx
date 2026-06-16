// The authenticated application shell: topbar (identity + logout), the tab bar,
// and the active tab's view. Routing is a pure lookup in the tab registry on nav
// state — no router. Theme selection now lives in the Settings tab.

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { TabBar } from "../nav/TabBar";
import { TABS } from "../nav/tabs";
import { Button } from "../../design-system/Button";

export function AppShell() {
  const activeTab = useAppStore((s) => s.state.nav.activeTab);
  const player = useAppStore((s) => s.state.auth.player);

  const logout = () => ipc.dispatch({ kind: "Auth", command: { type: "logout" } });
  const ActiveView = TABS[activeTab].Component;

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1 className="app-title">Forge Client</h1>
        <div className="spacer" />
        {player && <span className="player-name">{player.name}</span>}
        <Button onClick={logout}>Log out</Button>
      </header>

      <TabBar />

      <section className="content">
        <ActiveView />
      </section>
    </div>
  );
}
