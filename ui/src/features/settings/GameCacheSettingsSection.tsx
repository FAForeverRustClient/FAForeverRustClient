import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import type { GamePreferences } from "../../ipc/bindings";

const save = (preferences: GamePreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setGame", payload: { preferences } } });

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function GameCacheSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.game);
  const cacheInfo = useAppStore((state) => state.state.settings.cacheInfo);

  const setCacheLifetime = (days: number) => {
    void save({
      ...preferences,
      cacheLifetimeDays: days === 0 ? null : days,
    });
  };

  const setCacheSizeAlert = (gb: number) => {
    void save({
      ...preferences,
      cacheSizeAlertGb: gb === 0 ? null : gb,
    });
  };

  const handleRefreshCache = () => {
    void ipc.send({ kind: "Settings", command: { type: "refreshGameCache" } });
  };

  const handleClearCache = () => {
    void ipc.send({ kind: "Settings", command: { type: "clearGameCache" } });
  };

  const openVersionUrl = (url: string | null) => {
    if (url) {
      void native.openUrl(url);
    }
  };

  const handleOpenCacheFolder = () => {
    void native.openClientFolder("gameCache");
  };

  const currentLifetime = preferences.cacheLifetimeDays ?? 0;
  const currentAlertGb = preferences.cacheSizeAlertGb ?? 0;

  return (
    <>
      <SettingRow
        label={t("settings.game.cacheLifetime")}
        hint={t("settings.game.cacheLifetimeHint")}
      >
        <select
          className="settings-select"
          value={currentLifetime}
          onChange={(event) => setCacheLifetime(Number(event.target.value))}
          aria-label={t("settings.game.cacheLifetime")}
        >
          <option value={30}>{t("settings.game.cacheLifetime.default")}</option>
          <option value={14}>{t("settings.game.cacheLifetime.days", { days: "14" })}</option>
          <option value={60}>{t("settings.game.cacheLifetime.days", { days: "60" })}</option>
          <option value={90}>{t("settings.game.cacheLifetime.days", { days: "90" })}</option>
          <option value={0}>{t("settings.game.cacheLifetime.disabled")}</option>
        </select>
      </SettingRow>

      <SettingRow
        label={t("settings.game.cacheSizeAlert")}
        hint={t("settings.game.cacheSizeAlertHint")}
      >
        <select
          className="settings-select"
          value={currentAlertGb}
          onChange={(event) => setCacheSizeAlert(Number(event.target.value))}
          aria-label={t("settings.game.cacheSizeAlert")}
        >
          <option value={10}>{t("settings.game.cacheSizeAlert.default")}</option>
          <option value={5}>{t("settings.game.cacheSizeAlert.gb", { gb: "5" })}</option>
          <option value={15}>{t("settings.game.cacheSizeAlert.gb", { gb: "15" })}</option>
          <option value={20}>{t("settings.game.cacheSizeAlert.gb", { gb: "20" })}</option>
          <option value={30}>{t("settings.game.cacheSizeAlert.gb", { gb: "30" })}</option>
          <option value={0}>{t("settings.game.cacheSizeAlert.disabled")}</option>
        </select>
      </SettingRow>

      <SettingRow
        label={t("settings.game.cacheRollingBranches")}
        hint={t("settings.game.cacheRollingBranchesHint")}
      >
        <SettingsSwitch
          checked={preferences.cacheRollingBranches ?? false}
          onChange={(cacheRollingBranches) => void save({ ...preferences, cacheRollingBranches })}
          label={t("settings.game.cacheRollingBranches")}
        />
      </SettingRow>

      <div className="setting-block">
        <div className="setting-copy">
          <span className="setting-label">{t("settings.game.cacheStorage")}</span>
          <span className="muted">{t("settings.game.cacheStorageHint")}</span>
        </div>

        <div className="settings-cache-box">
          <div className="settings-cache-stats">
            <div>
              <span className="setting-label">
                {formatBytes(cacheInfo?.totalSizeBytes ?? 0)}
              </span>
              <span className="muted">
                {" "}({cacheInfo?.totalFiles ?? 0} {t("settings.game.cacheFiles")})
              </span>
            </div>
            <div className="settings-save-line" style={{ margin: 0 }}>
              <Button onClick={handleOpenCacheFolder}>{t("settings.game.openCacheFolder")}</Button>
              <Button onClick={handleRefreshCache}>{t("settings.game.refreshCache")}</Button>
              <Button onClick={handleClearCache}>{t("settings.game.clearCache")}</Button>
            </div>
          </div>

          <div>
            <div className="muted" style={{ fontSize: "11px", marginBottom: "4px" }}>
              {t("settings.game.cachedVersions")}:
            </div>
            {cacheInfo?.versions && cacheInfo.versions.length > 0 ? (
              <div className="settings-cache-versions">
                {cacheInfo.versions.map((ver) => (
                  <div key={ver.name} className="settings-cache-chip-container">
                    <button
                      type="button"
                      className="settings-cache-chip"
                      onClick={() => void native.openVersionFolder(ver.name)}
                      title={t("settings.game.openLocalFolder", { name: ver.name })}
                    >
                      <Icon name="folder" size={13} className="settings-cache-chip-folder-icon" />
                      <span>{ver.name}</span>
                      <span className="settings-cache-chip-size">
                        ({formatBytes(ver.sizeBytes)})
                      </span>
                    </button>
                    {ver.url ? (
                      <button
                        type="button"
                        className="settings-cache-chip-ext"
                        onClick={() => openVersionUrl(ver.url)}
                        title={t("settings.game.openReleaseNotes", { name: ver.name })}
                        aria-label={t("settings.game.openReleaseNotes", { name: ver.name })}
                      >
                        <Icon name="external" size={12} />
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : (
              <span className="muted" style={{ fontSize: "11px" }}>
                {t("settings.game.noCachedVersions")}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
