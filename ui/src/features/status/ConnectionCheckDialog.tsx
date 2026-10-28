// "Check connection", from the FAF connection button in the status bar (#647).
//
// The connectivity check and the live view of the players in a game used to
// be reachable only from Settings, under Connectivity, which is where nobody
// looks for them while a lobby will not connect. The thread settled on the
// button that already says whether FAF is connected: its menu offers the
// check, and this small dialog runs it and, in a game, lists the players and
// how each one is reached. The Settings page keeps the same view.

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

export function ConnectionCheckDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const check = useAppStore((state) => state.state.connectivity.check);
  const relay = useAppStore((state) => state.state.connectivity.relay);
  const inGame = useAppStore((state) => state.state.lobby.join.type === "inGame");
  useLiveRelayPolling(inGame);

  return (
    <Modal className="confirm-modal connection-check-modal" onClose={onClose}>
      <div className="confirm-dialog-content">
        <h2>{t("status.connectionCheck.title")}</h2>
        <p className="muted">{t("status.connectionCheck.body")}</p>
        <div>
          <Button onClick={runConnectivityCheck} disabled={check.status.type === "running"}>
            {checkRunLabel(check, t)}
          </Button>
        </div>
        {check.status.type !== "idle" && <CheckResults check={check} />}
        <h3>{t("settings.liveRelay.label")}</h3>
        {inGame ? <LiveRelay relay={relay} /> : <p className="muted">{t("settings.liveRelay.noGame")}</p>}
        <div className="confirm-dialog-actions">
          <Button onClick={onClose}>{t("common.close")}</Button>
        </div>
      </div>
    </Modal>
  );
}
