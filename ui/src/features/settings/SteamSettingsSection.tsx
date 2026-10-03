import { useState } from "react";
import { ConfirmDialog } from "../../design-system/ConfirmDialog";
import type { GamePreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { steamStatusIsSupported } from "../../shared/platform";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import { useTranslation } from "../../i18n/useTranslation";

const save = (preferences: GamePreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setGame", payload: { preferences } } });

/**
 * Whether Steam shows Forged Alliance as being played while a game runs
 * (issue 364).
 *
 * Beside the Discord rows rather than with the game settings, because it is
 * the same kind of question: what a third party is told about you. The value
 * itself lives with the game preferences, since the launcher is what acts on
 * it. Off by default, and only where the client ships Valve's library.
 *
 * Marked experimental, and turning it on asks first: the Steamworks library
 * is closed source, so the client can say which calls it makes but not what
 * the library does with them. Switching it off again never asks.
 */
export function SteamSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.game);
  const [confirming, setConfirming] = useState(false);

  if (!steamStatusIsSupported()) return null;

  return (
    <>
      <SettingRow
        className="setting-row-with-note"
        label={t("settings.steam.presence")}
        hint={t("settings.steam.presenceHint")}
        badge={<span className="setting-experimental-badge">{t("settings.game.experimentalBadge")}</span>}
      >
        <SettingsSwitch
          checked={preferences.steamPresence ?? false}
          onChange={(steamPresence) => {
            if (steamPresence) setConfirming(true);
            else void save({ ...preferences, steamPresence });
          }}
          label={t("settings.steam.presence")}
        />
      </SettingRow>
      {/* What the switch above means, so it hangs from that row without a rule
          between them: with one it read as a setting of its own. */}
      <div className="setting-block setting-row-note">
        <span className="setting-label">{t("settings.steam.trustTitle")}</span>
        <span className="muted">{t("settings.steam.trustCalls")}</span>
        <span className="muted">{t("settings.steam.trustClosed")}</span>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t("settings.steam.confirmTitle")}
          body={t("settings.steam.confirmBody")}
          confirmLabel={t("settings.steam.confirmButton")}
          onConfirm={() => {
            setConfirming(false);
            void save({ ...preferences, steamPresence: true });
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}
