// Settings → Game → Launch: which engine plays the game. The original
// `ForgedAlliance.exe` of the FAF install, or faf-re, the engine rebuilt from
// source (github.com/Draiget/faf-re), whose `main_x64.exe` takes the same
// command line and plays the same install's files. Replays stay on the
// original: see `GamePreferences::rebuilt_engine` in faf-domain.

import type { GamePreferencesPatch } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { Button } from "../../design-system/Button";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { SettingRow } from "./SettingControls";

/**
 * Saved through `settle`, because the executable is a program the client
 * starts: the shell refuses one that was not picked in its own dialog, and
 * that refusal is reported rather than lost.
 */
const save = (patch: GamePreferencesPatch) =>
  ipc.settle({ kind: "Settings", command: { type: "patchGame", payload: { patch } } });

export function RebuiltEngineSettings() {
  const { t } = useTranslation();
  const enabled = useAppStore((state) => state.state.settings.game.rebuiltEngine ?? false);
  const exe = useAppStore((state) => state.state.settings.game.rebuiltEngineExe ?? "");

  /** Opens on the executable already chosen, so a rebuild is one click away. */
  const pick = () =>
    native.selectFile({
      filters: [{ name: "main_x64.exe", extensions: ["exe"] }],
      defaultPath: exe || undefined,
    });

  const choose = (rebuilt: boolean) => {
    if (!rebuilt || exe) {
      ipc.run(save({ rebuiltEngine: rebuilt }));
      return;
    }
    // Nothing to play with yet: ask for the executable first, and switch only
    // once there is one, so a cancelled dialog leaves the original in place.
    ipc.run(
      pick().then((path) => (path ? save({ rebuiltEngine: true, rebuiltEngineExe: path }) : undefined)),
    );
  };

  const browse = () => {
    ipc.run(pick().then((path) => (path ? save({ rebuiltEngineExe: path }) : undefined)));
  };

  return (
    <>
      <SettingRow label={t("settings.game.engine")} hint={t("settings.game.engineHint")}>
        <select
          className="settings-select"
          value={enabled ? "rebuilt" : "original"}
          onChange={(event) => choose(event.target.value === "rebuilt")}
          aria-label={t("settings.game.engine")}
        >
          <option value="original">{t("settings.game.engine.original")}</option>
          <option value="rebuilt">{t("settings.game.engine.rebuilt")}</option>
        </select>
      </SettingRow>
      {enabled && (
        <div className="settings-path-row">
          <div className="settings-path-info">
            <span className="settings-path-label">{t("settings.game.engineExe")}</span>
            <span className="settings-path-value">{exe || t("settings.paths.unset")}</span>
            {!exe && (
              <span className="settings-path-status is-missing">{t("settings.game.engineExeMissing")}</span>
            )}
          </div>
          <Button onClick={browse}>{t("settings.paths.browse")}</Button>
        </div>
      )}
    </>
  );
}
