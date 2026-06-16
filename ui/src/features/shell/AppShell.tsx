// The authenticated application shell: topbar (identity + logout), tab bar, and
// the active tab's content. Tab routing is a pure switch on nav state — no router.

import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { TabBar } from "../nav/TabBar";
import { HomeScreen } from "../home/HomeScreen";
import { LobbyView } from "../lobby/LobbyView";

export function AppShell() {
  const activeTab = useAppStore((s) => s.state.nav.activeTab);
  const player = useAppStore((s) => s.state.auth.player);

  const logout = () => ipc.dispatch({ kind: "Auth", command: { type: "logout" } });

  return (
    <div className="app-shell">
      <header className="topbar">
        <h1 className="app-title">Forge Client</h1>
        <TabBar />
        <div className="spacer" />
        {player && <span className="player-name">{player.name}</span>}
        <button className="btn-ghost" onClick={logout}>
          Log out
        </button>
      </header>

      <section className="content">
        {activeTab === "home" ? <HomeScreen /> : <LobbyView />}
      </section>
    </div>
  );
}
