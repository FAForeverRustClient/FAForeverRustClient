// Home tab content. Connection status + a welcome line. Pure presentation.
// (The sidebar/logout live in AppShell so they persist across tabs.)

import { useAppStore } from "../../store/store";
import { StatusBar } from "../status/StatusBar";
import { ipc } from "../../ipc/client";
import { Icon } from "../../design-system/Icon";
import type { Tab } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import "./home.css";

export function HomeScreen() {
  const { t } = useTranslation();
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
        <div className="eyebrow">{t("home.eyebrow")}</div>
        <h2>{player ? t("home.welcomeBack", { name: player.name }) : t("home.welcome")}</h2>
        <p>{t("home.subtitle")}</p>
        <button className="home-primary-action" onClick={() => open("play")}>
          {t("home.browseGames")} <Icon name="arrowRight" size={17} />
        </button>
      </section>

      <div className="home-metrics">
        <button className="metric-card surface-panel surface-interactive" onClick={() => open("play")}>
          <span className="metric-icon"><Icon name="play" size={18} /></span>
          <span><strong>{games}</strong><small>{t("home.openGames")}</small></span>
        </button>
        <button className="metric-card surface-panel surface-interactive" onClick={() => open("chat")}>
          <span className="metric-icon"><Icon name="chat" size={18} /></span>
          <span><strong>{users}</strong><small>{t("home.playersOnline")}</small></span>
        </button>
        <button className="metric-card surface-panel surface-interactive" onClick={() => open("replays")}>
          <span className="metric-icon"><Icon name="replays" size={18} /></span>
          <span><strong>{replays}</strong><small>{t("home.vaultReplays")}</small></span>
        </button>
      </div>

      <section className="home-system-card surface-panel">
        <div className="home-system-icon"><Icon name="activity" size={19} /></div>
        <div>
          <h3>{t("home.clientStatus")}</h3>
          <p>{t("home.clientStatusHint")}</p>
        </div>
        <StatusBar />
      </section>
    </div>
  );
}
