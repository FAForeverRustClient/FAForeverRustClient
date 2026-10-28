// "Check connection", from the FAF connection button in the status bar (#647).
//
// The connectivity check and the live view of the players in a game used to
// be reachable only from Settings, under Connectivity, which is where nobody
// looks for them while a lobby will not connect. The thread settled on the
// button that already says whether FAF is connected: its menu offers the
// check, and this dialog runs it and, in a game, lists the players and how
// each one is reached. The Settings page keeps the same view.
//
// The check starts as the dialog opens: asking for it is why the dialog was
// opened. Wide, with the check and the live connections side by side, because
// a check line carries a sentence of explanation and a column the width of a
// confirmation stacked every one of them into a tall, thin strip.

import { useEffect } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { useTranslation } from "../../i18n/useTranslation";
import { useAppStore } from "../../store/store";
import {
  CheckResults,
  checkRunLabel,
  LiveRelay,
  runConnectivityCheck,
  useLiveRelayPolling,
} from "../settings/ConnectivityDiagnosticsSection";
import "../settings/connectivity-check.css";
import "./connection-check-dialog.css";

export function ConnectionCheckDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const check = useAppStore((state) => state.state.connectivity.check);
  const relay = useAppStore((state) => state.state.connectivity.relay);
  const inGame = useAppStore((state) => state.state.lobby.join.type === "inGame");
  const running = check.status.type === "running";
  useLiveRelayPolling(inGame);

  // Once per opening, unless one is already under way.
  useEffect(() => {
    if (useAppStore.getState().state.connectivity.check.status.type !== "running") runConnectivityCheck();
  }, []);

  return (
    <Modal className="connection-check-modal" onClose={onClose} ariaLabel={t("status.connectionCheck.title")}>
      <header className="connection-check-head">
        <div>
          <h2>{t("status.connectionCheck.title")}</h2>
          <p className="muted">{t("status.connectionCheck.body")}</p>
        </div>
        <Button onClick={runConnectivityCheck} disabled={running}>
          {checkRunLabel(check, t)}
        </Button>
      </header>
      <div className="connection-check-columns">
        <section className="connection-check-column" aria-labelledby="connection-check-test">
          <h3 id="connection-check-test">{t("settings.connectivityCheck.label")}</h3>
          {check.status.type === "idle"
            ? <p className="muted">{t("settings.connectivityCheck.running")}</p>
            : <CheckResults check={check} />}
        </section>
        <section className="connection-check-column" aria-labelledby="connection-check-live">
          <h3 id="connection-check-live">{t("settings.liveRelay.label")}</h3>
          {inGame ? <LiveRelay relay={relay} /> : <p className="muted">{t("settings.liveRelay.noGame")}</p>}
        </section>
      </div>
    </Modal>
  );
}
