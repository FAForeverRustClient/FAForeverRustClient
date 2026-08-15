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
import { t } from "../../i18n";
import { useLocale } from "../../i18n/useTranslation";

const send = (type: "check" | "download" | "install" | "dismiss") =>
  ipc.send({ kind: "ClientUpdate", command: { type } });

/** Bytes as something a person can read, matching the vault's sizing style. */
export function formatSize(bytes: number): string {
  if (bytes <= 0) return "";
  const megabytes = bytes / (1024 * 1024);
  return megabytes >= 1 ? `${megabytes.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function UpdateBanner() {
  useLocale();
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
            ? t("updates.available.prerelease", { version: release.version })
            : t("updates.available.stable", { version: release.version })}
        </strong>
        <span className="muted">{describe(status, release, update.currentVersion, size, percent)}</span>
      </div>
      <div className="update-banner-actions">
        {status.type === "ready" ? (
          <Button variant="primary" onClick={() => void send("install")}>
            {t("updates.runInstaller")}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!release.downloadUrl || status.type === "downloading" || status.type === "installing"}
            title={
              release.downloadUrl
                ? undefined
                : t("updates.noInstaller")
            }
            onClick={() => void send("download")}
          >
            {status.type === "downloading" ? t("updates.downloading") : t("updates.download")}
          </Button>
        )}
        {/* A release can be published without notes; an empty href would just
            open a blank tab. */}
        {notesUrl && (
          <Button onClick={() => void openHttpsUrl(notesUrl)}>
            {t("updates.whatsNew")}
          </Button>
        )}
        <button
          type="button"
          className="update-banner-close"
          aria-label={t("updates.dismiss")}
          title={t("updates.dismissTitle", { version: release.version })}
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
  const running = currentVersion ? t("updates.running", { version: currentVersion }) : "";
  switch (status.type) {
    case "downloading":
      return percent === null
        ? t("updates.progress.indeterminate")
        : t("updates.progress.percent", { percent });
    case "ready":
      // The client cannot replace its own running executable, so the copy says
      // so rather than letting the installer fail halfway through.
      return t("updates.ready");
    case "installing":
      return t("updates.started");
    case "failed":
      return status.payload.reason;
    default:
      return release.downloadUrl
        ? `${running} The installer is ${size || "ready to download"}.`.trim()
        : `${running} Release ${release.version} has no installer for your platform.`.trim();
  }
}
