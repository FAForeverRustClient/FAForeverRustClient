import type { ClientUpdateState, UpdatePreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { Button } from "../../design-system/Button";
import { useAppStore } from "../../store/store";
import { isUpdateBusy } from "../../store/reducers/clientUpdate";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import "../updates/updates.css";
import { t } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

const save = (preferences: UpdatePreferences) =>
  ipc.send({
    kind: "Settings",
    command: { type: "setUpdates", payload: { preferences } },
  });

const checkNow = () => ipc.send({ kind: "ClientUpdate", command: { type: "check" } });

export function UpdatesSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((s) => s.state.settings.updates);
  const update = useAppStore((s) => s.state.clientUpdate);

  return (
    <>
      <SettingRow
        label={t("settings.updates.checkUpdatesAt")}
        hint={t("settings.updates.checkUpdatesAtHint")}
      >
        <SettingsSwitch
          checked={preferences.automatic}
          onChange={(automatic) => void save({ ...preferences, automatic })}
          label={t("settings.updates.checkUpdatesAt")}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.updates.includePreReleases")}
        hint={t("settings.updates.includePreReleasesHint")}
      >
        <SettingsSwitch
          checked={preferences.preRelease}
          onChange={(preRelease) => void save({ ...preferences, preRelease })}
          label={t("settings.updates.includePreReleases")}
        />
      </SettingRow>
      <SettingRow
        label={t("settings.updates.updateStatus")}
        hint={t("settings.updates.updateStatusHint")}
        className="setting-row-update-status"
      >
        {/* The status first and the button at the row's edge, where every
            other row in Settings keeps its control. */}
        <div className="update-settings-status">
          <UpdateStatus update={update} />
          <Button onClick={() => void checkNow()} disabled={isUpdateBusy(update.status)}>
            {t("settings.updates.checkNow")}
          </Button>
        </div>
      </SettingRow>
    </>
  );
}

/**
 * The status in two lines: what the check found, then the version running and
 * when we last found it out.
 *
 * The timestamp is the whole point of the second line. Two checks in a row
 * settle on the same status, so the line said exactly the same thing after
 * the second click as after the first, and "Check now" read as a button that
 * does nothing. The timestamp changes every time, which is the visible answer
 * to "did that do anything". Split from the status because one long sentence
 * beside the button wrapped wherever the window put its edge.
 */
function UpdateStatus({ update }: { update: ClientUpdateState }) {
  const { headline, tone } = describeStatus(update);
  const running = update.currentVersion
    ? t("settings.updates.running", { version: update.currentVersion })
    : t("settings.updates.versionUnknown");
  const checked = formatChecked(update.lastChecked);
  return (
    <span className="update-settings-text">
      <span className={`update-settings-headline${tone ? ` is-${tone}` : ""}`}>{headline}</span>
      <span className="update-settings-meta">
        {checked ? `${running} · ${t("settings.updates.lastChecked", { time: checked })}` : running}
      </span>
    </span>
  );
}

function describeStatus(update: ClientUpdateState): { headline: string; tone: "ok" | "warn" | "error" | null } {
  switch (update.status.type) {
    case "idle":
      return { headline: t("settings.updates.notCheckedYet"), tone: null };
    case "checking":
      return { headline: t("settings.updates.checking"), tone: null };
    case "upToDate":
      return { headline: t("settings.updates.upToDate"), tone: "ok" };
    case "available":
    case "downloading":
    case "ready":
    case "installing":
      return {
        headline: t("settings.updates.newerAvailable", {
          version: update.release?.version ?? t("settings.updates.aNewerVersion"),
        }),
        tone: "warn",
      };
    case "failed":
      // Shown here even when the banner stays hidden: a background check that
      // keeps failing should be discoverable somewhere rather than nowhere.
      return { headline: update.status.payload.reason, tone: "error" };
  }
}

/** Empty when nothing has been checked, or when the stamp is unreadable. */
function formatChecked(timestamp: string | undefined): string {
  if (!timestamp) return "";
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return "";
  // Explicitly English, matching the notification centre's clock: the
  // repository's rule is that no view inherits the operating system's locale
  // while the catalogue is the only place language is chosen.
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(at);
}
