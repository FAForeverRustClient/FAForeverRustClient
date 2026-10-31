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
// opened. It is sized to fit a window without scrolling: one line per finding,
// and no heading over the check that repeats the dialog's title. The results
// use the width of the dialog unless a game is running, when live connections
// get a second column beside the check; outside a game they are one line at
// the foot saying when they appear.

import { useEffect } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
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
    <Modal className={`connection-check-modal${inGame ? " has-live" : ""}`} onClose={onClose} ariaLabel={t("status.connectionCheck.title")}>
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
        <section className="connection-check-column" aria-label={t("settings.connectivityCheck.label")}>
          {check.status.type === "idle"
            ? <p className="muted">{t("settings.connectivityCheck.running")}</p>
            : <CheckResults check={check} />}
        </section>
        {inGame ? (
          <section className="connection-check-column" aria-labelledby="connection-check-live">
            <h3 id="connection-check-live">{t("settings.liveRelay.label")}</h3>
            <LiveRelay relay={relay} />
          </section>
        ) : (
          <section className="connection-check-live-note" aria-labelledby="connection-check-live">
            <Icon name="info" size={15} />
            <p>
              <strong id="connection-check-live">{t("settings.liveRelay.label")}</strong>
              {" "}
              {t("status.connectionCheck.liveHint")}
            </p>
          </section>
        )}
      </div>
    </Modal>
  );
}
