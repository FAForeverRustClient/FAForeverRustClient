// Client update banner: appears at the top of the workspace when a newer
// release exists.
//
// The Java client uses a persistent notification for this; a banner is the
// closer fit here because the client already has one (`InstallBanner`) in the
// same slot, and because an update is a state of the client rather than an
// event that happened at a moment.
//
// Everything shown is derived from backend state, including the dismissal:
// `banner_release` in the domain decides what is visible, and its twin in
// `store/reducers/clientUpdate.ts` reproduces it. There is deliberately no
// local `dismissed` flag: that is how a banner ends up disagreeing with the
// state it is supposed to be rendering.

import type { ClientRelease, ClientUpdateState } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { openHttpsUrl, optionalHttpsUrl } from "../../shared/externalLinks";
import { useAppStore } from "../../store/store";
import { updateBannerRelease, updatePercent } from "../../store/reducers/clientUpdate";
import "./updates.css";

const send = (type: "check" | "download" | "install" | "dismiss") =>
  ipc.send({ kind: "ClientUpdate", command: { type } });

/** Bytes as something a person can read, matching the vault's sizing style. */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function UpdateBanner() {
  const update = useAppStore((s) => s.state.clientUpdate);
  const release = updateBannerRelease(update);
  if (release === null) return null;

  const status = update.status;
  const percent = updatePercent(status);
  const size = formatSize(release.sizeBytes);
  const notesUrl = optionalHttpsUrl(release.notesUrl);

  return (
    <div className="update-banner" role="status">
      <span className="update-banner-icon" aria-hidden="true">
        <Icon name="arrowRight" size={16} />
      </span>
      <div className="update-banner-copy">
        <strong>
          {release.preRelease
            ? `Pre-release ${release.version} is available`
            : `Version ${release.version} is available`}
        </strong>
        <span className="muted">{describe(status, release, update.currentVersion, size, percent)}</span>
      </div>
      <div className="update-banner-actions">
        {status.type === "ready" ? (
          <Button variant="primary" onClick={() => void send("install")}>
            Run installer
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!release.downloadUrl || status.type === "downloading" || status.type === "installing"}
            title={
              release.downloadUrl
                ? undefined
                : "This release has no installer for your platform: see the release notes"
            }
            onClick={() => void send("download")}
          >
            {status.type === "downloading" ? "Downloading…" : "Download update"}
          </Button>
        )}
        {/* A release can be published without notes; an empty href would just
            open a blank tab. */}
        {notesUrl && (
          <Button onClick={() => void openHttpsUrl(notesUrl)}>
            What&apos;s new
          </Button>
        )}
        <button
          type="button"
          className="update-banner-close"
          aria-label="Dismiss"
          title={`Hide until a version newer than ${release.version}`}
          onClick={() => void send("dismiss")}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {percent !== null && (
        <div className="update-banner-progress" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}

function describe(
  status: ClientUpdateState["status"],
  release: ClientRelease,
  currentVersion: string,
  size: string,
  percent: number | null,
): string {
  const running = currentVersion ? `You are on ${currentVersion}.` : "";
  switch (status.type) {
    case "downloading":
      return percent === null
        ? "Downloading the installer…"
        : `Downloading the installer: ${percent}%`;
    case "ready":
      // The client cannot replace its own running executable, so the copy says
      // so rather than letting the installer fail halfway through.
      return "The installer is ready. Close the client once it starts.";
    case "installing":
      return "The installer has started. Close the client to let it finish.";
    case "failed":
      return status.payload.reason;
    default:
      return release.downloadUrl
        ? `${running} The installer is ${size || "ready to download"}.`.trim()
        : `${running} Release ${release.version} has no installer for your platform.`.trim();
  }
}
