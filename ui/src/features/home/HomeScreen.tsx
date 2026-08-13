// Home tab content. Connection status + a welcome line. Pure presentation.
// (The sidebar/logout live in AppShell so they persist across tabs.)

import { useAppStore } from "../../store/store";
import { StatusBar } from "../status/StatusBar";
import { ipc } from "../../ipc/client";
import { Icon } from "../../design-system/Icon";
import type { Tab } from "../../ipc/bindings";
import "./home.css";

export function HomeScreen() {
  const player = useAppStore((s) => s.state.auth.player);
  const games = useAppStore((s) => s.state.lobby.games.length);
  // "Players online" is the roster of the main channel: the closest thing the
  // client has to a global presence count.
  const users = useAppStore(
    (s) => s.state.chat.channels.find((c) => c.name === "#aeolus")?.users.length ?? 0,
  );
  const replays = useAppStore((s) => s.state.replays.vault.length);

  const open = (tab: Tab) =>
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab } } });

  return (
    <div className="home">
      <section className="home-hero">
        <div className="eyebrow">Command center</div>
        <h2>Welcome back{player ? `, ${player.name}` : ""}.</h2>
        <p>Find a match, catch up with the community, or continue exploring Forged Alliance.</p>
        <button className="home-primary-action" onClick={() => open("play")}>
          Browse open games <Icon name="arrowRight" size={17} />
        </button>
      </section>

      <div className="home-metrics">
        <button className="metric-card surface-panel surface-interactive" onClick={() => open("play")}>
          <span className="metric-icon"><Icon name="play" size={18} /></span>
          <span><strong>{games}</strong><small>Open games</small></span>
        </button>
        <button className="metric-card surface-panel surface-interactive" onClick={() => open("chat")}>
          <span className="metric-icon"><Icon name="chat" size={18} /></span>
          <span><strong>{users}</strong><small>Players online</small></span>
        </button>
        <button className="metric-card surface-panel surface-interactive" onClick={() => open("replays")}>
          <span className="metric-icon"><Icon name="replays" size={18} /></span>
          <span><strong>{replays}</strong><small>Vault replays</small></span>
        </button>
      </div>

      <section className="home-system-card surface-panel">
        <div className="home-system-icon"><Icon name="activity" size={19} /></div>
        <div>
          <h3>Client status</h3>
          <p>Backend connection and local client version.</p>
        </div>
        <StatusBar />
      </section>
    </div>
  );
}
