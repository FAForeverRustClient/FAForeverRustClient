// The update the client will not carry on without.
//
// The banner beside this file is an offer, and an offer can be waved away,
// per version, deliberately, because most updates are features and features
// can wait for a better moment. Security fixes cannot: a client that stays on
// the old build stays on whatever was wrong with it, and "dismiss" is exactly
// the button somebody presses for the next three weeks.
//
// So a stable release the client can install itself stops being an offer and
// becomes a gate. `updateRequiredRelease` decides that, mirroring the domain,
// and it refuses to gate in the cases where gating would trap somebody: a
// prerelease, a release with no installer for this platform, and anything
// short of a check that actually found a newer version. This file adds two
// more: a join or matchmaker search in progress, and a download that has
// failed, after which the player may carry on for the rest of the session.
//
// The banner stays mounted underneath. When the gate lifts for a game, the
// banner is what keeps the update visible.

import { useState } from "react";
import type { ClientRelease, ClientUpdateState } from "../../ipc/bindings";
import { Modal } from "../../design-system/Modal";
import { Button } from "../../design-system/Button";
import { ipc } from "../../ipc/client";
import { openHttpsUrl, optionalHttpsUrl } from "../../shared/externalLinks";
import { useAppStore } from "../../store/store";
import { updatePercent, updateRequiredRelease } from "../../store/reducers/clientUpdate";
import { formatSize } from "./UpdateBanner";
import "./updates.css";
import { useTranslation } from "../../i18n/useTranslation";

const send = (type: "download" | "install") =>
  ipc.send({ kind: "ClientUpdate", command: { type } });

/** Whether the gate stands, and the release it is standing for. */
export function UpdateGate() {
  const update = useAppStore((s) => s.state.clientUpdate);
  const join = useAppStore((s) => s.state.lobby.join);
  const matchmaking = useAppStore((s) => s.state.lobby.matchmaking);
  // The version the player chose to carry on without, for this session only:
  // offered once a download has failed, so a network that can never fetch the
  // installer does not lock the whole client. Not persisted on purpose; the
  // gate is back at the next start, and the banner keeps the update in view.
  const [deferred, setDeferred] = useState<string | null>(null);

  const release = updateRequiredRelease(update);
  if (release === null || deferred === release.version) return null;

  // The one carve-out that is not the domain's to make, because the domain's
  // update slice cannot see the lobby. Taking the client away mid-match costs
  // the player the chat, the lobby and the score screen of a game already
  // running, which is a worse outcome than another twenty minutes on the old
  // build. The gate returns by itself when the game ends. Every stage of a
  // join counts, not only the running game: a gate that rose over a map
  // download or the preparation dialog covered the one way to cancel it. So
  // does a matchmaker search, whose match-found prompt has a timer.
  if (join.type !== "idle") return null;
  if (matchmaking.type !== "idle" && matchmaking.type !== "cancelled") return null;

  return (
    <UpdateGateDialog
      release={release}
      status={update.status}
      currentVersion={update.currentVersion}
      onDefer={() => setDeferred(release.version)}
    />
  );
}

interface DialogProps {
  release: ClientRelease;
  status: ClientUpdateState["status"];
  currentVersion: string;
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
export function UpdateGateDialog({ release, status, currentVersion, onDefer }: DialogProps) {
  const { t } = useTranslation();
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
      >
        {describe(status, t)}
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
            disabled={status.type === "installing"}
            onClick={() => void send("install")}
          >
            {t("updates.runInstaller")}
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
      return t("updates.ready");
    case "installing":
      return t("updates.required.closeToFinish");
    case "failed":
      return status.payload.reason;
    default:
      return t("updates.installerReady");
  }
}
