import type { GamePreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { runsOnWindows } from "../../shared/platform";
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
 * it. Off by default, and only on Windows, where Valve's library can run.
 */
export function SteamSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.game);

  if (!runsOnWindows()) return null;

  return (
    <SettingRow label={t("settings.steam.presence")} hint={t("settings.steam.presenceHint")}>
      <SettingsSwitch
        checked={preferences.steamPresence ?? false}
        onChange={(steamPresence) => void save({ ...preferences, steamPresence })}
        label={t("settings.steam.presence")}
      />
    </SettingRow>
  );
}
