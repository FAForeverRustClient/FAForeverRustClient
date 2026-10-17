// The update the client will not carry on without.
//
// Most updates are offers: the sidebar notice (UpdateNotice.tsx) says one is
// there, and the player picks the moment. An offer can be put off for ever,
// though, and a client that stays on an old build stays on whatever was wrong
// with it. So an installable release that is overdue (three days after it was
// published, or two releases behind: `is_overdue` in the domain) becomes this
// gate. It is never raised for a release with no installer for this platform,
// nor before a check has found something, and it stands aside during a join
// or matchmaker search and after a failed download the player chose to defer
// (`useGatedUpdate`).

import type { ClientRelease, ClientUpdateState } from "../../ipc/bindings";
import { Modal } from "../../design-system/Modal";
import { Button } from "../../design-system/Button";
import { ipc } from "../../ipc/client";
import { openHttpsUrl, optionalHttpsUrl } from "../../shared/externalLinks";
import { plainError } from "../../shared/plainError";
import { useAppStore } from "../../store/store";
import { updatePercent } from "../../store/reducers/clientUpdate";
import { formatSize } from "../../shared/format/installerSize";
import { formatDate } from "../../shared/format/dates";
import { installerRestartsClient } from "./installerCopy";
import { useGatedUpdate } from "./useGatedUpdate";
import "./updates.css";
import { useTranslation } from "../../i18n/useTranslation";

const send = (type: "download" | "install") =>
  ipc.send({ kind: "ClientUpdate", command: { type } });

/** Whether the gate stands, and the release it is standing for. */
export function UpdateGate({ deferredVersion = null, onDefer }: { deferredVersion?: string | null; onDefer?: (version: string) => void }) {
  const update = useAppStore((s) => s.state.clientUpdate);
  const release = useGatedUpdate(deferredVersion);
  if (release === null) return null;
  return <UpdateGateDialog release={release} status={update.status} currentVersion={update.currentVersion}
    waiting={update.installWaiting === true} onDefer={onDefer ? () => onDefer(release.version) : undefined} />;
}

interface DialogProps {
  release: ClientRelease;
  status: ClientUpdateState["status"];
  currentVersion: string;
  /** Install is held until the last game has finished saving. */
  waiting?: boolean;
  /** Carry on without the update for this session; offered after a failure. */
  onDefer?: () => void;
}

/**
 * The gate itself, given everything it shows.
 *
 * Split from the component above so it can be rendered from a test: this
 * repository has no DOM in its test environment, and anything that reads the
 * store renders as though the store were empty.
 */
export function UpdateGateDialog({ release, status, currentVersion, waiting = false, onDefer }: DialogProps) {
  const { t } = useTranslation();
  const restarts = installerRestartsClient(release);
  const percent = updatePercent(status);
  const notesUrl = optionalHttpsUrl(release.notesUrl);
  const size = formatSize(release.sizeBytes);

  return (
    <Modal
      onClose={() => undefined}
      dismissible={false}
      className="update-gate"
      ariaLabel={t("updates.required.title")}
    >
      <h2 className="update-gate-title">
        {t("updates.required.heading", { version: release.version })}
      </h2>
      <p className="update-gate-why">{t("updates.required.why")}</p>
      {release.publishedAt && !Number.isNaN(Date.parse(release.publishedAt)) && <p className="update-gate-versions muted">{t("updates.required.since", { date: formatDate(release.publishedAt) })}</p>}
      <p className="update-gate-versions muted">
        {t("updates.required.from", {
          current: currentVersion,
          version: release.version,
        })}
        {size ? ` ${t("updates.installerSize", { size })}` : ""}
      </p>

      {/* Whatever the client is doing about it right now: the progress of a
          download, the instruction after one, or the reason the last attempt
          did not work. A failure leaves the gate up and turns the button into
          a retry, because failing a download is not a way past an update. */}
      <p
        className={
          status.type === "failed"
            ? "update-gate-status update-gate-status-failed"
            : "update-gate-status"
        }
        role="status"
        // The updater's own words on hover, for a bug report; the line
        // itself says them plainly.
        title={status.type === "failed" ? status.payload.reason : undefined}
      >
        {waiting && status.type === "ready" ? t("updates.waitingForGame") : describe(status, restarts, t)}
      </p>
      {percent !== null && (
        <div className="update-gate-progress" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </div>
      )}

      <div className="update-gate-actions">
        {status.type === "ready" || status.type === "installing" ? (
          <Button
            variant="primary"
            disabled={status.type === "installing" || (waiting && status.type === "ready")}
            onClick={() => void send("install")}
          >
            {t(restarts ? "updates.updateAndReopen" : "updates.runInstaller")}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={status.type === "downloading"}
            onClick={() => void send("download")}
          >
            {status.type === "failed"
              ? t("updates.required.retry")
              : status.type === "downloading"
                ? t("updates.downloading")
                : t("updates.required.install")}
          </Button>
        )}
        {notesUrl && (
          <Button onClick={() => void openHttpsUrl(notesUrl)}>
            {status.type === "failed" ? t("updates.required.openPage") : t("updates.whatsNew")}
          </Button>
        )}
        {/* The way out, and only after a failure: the normal path still
            cannot be waved away, but a download that cannot succeed here must
            not leave the player with no client at all. */}
        {status.type === "failed" && onDefer && (
          <Button onClick={onDefer}>{t("updates.required.later")}</Button>
        )}
      </div>
      {status.type === "failed" && (
        <p className="update-gate-versions muted">{t("updates.required.failedHint")}</p>
      )}
    </Modal>
  );
}

function describe(
  status: ClientUpdateState["status"],
  restarts: boolean,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  switch (status.type) {
    case "downloading": {
      const percent = updatePercent(status);
      return percent === null
        ? t("updates.progress.indeterminate")
        : t("updates.progress.percent", { percent });
    }
    case "ready":
      return t(restarts ? "updates.readyToReopen" : "updates.ready");
    case "installing":
      return t(restarts ? "updates.updating" : "updates.required.closeToFinish");
    case "failed":
      return plainError(status.payload.reason);
    default:
      return t("updates.installerReady");
  }
}
