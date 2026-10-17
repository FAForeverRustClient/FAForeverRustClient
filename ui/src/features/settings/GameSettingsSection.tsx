import { useEffect, useState } from "react";
import type { GamePreferencesPatch } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { Button } from "../../design-system/Button";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { SettingRow, SettingsSwitch } from "./SettingControls";
import { gameNeedsALaunchWrapper, runsOnWindows } from "../../shared/platform";
import { LinuxRuntimeSettings } from "./LinuxRuntimeSettings";

const save = (patch: GamePreferencesPatch) =>
  ipc.send({ kind: "Settings", command: { type: "patchGame", payload: { patch } } });

/**
 * Save a change to what the game is started with. The shell asks the player
 * to confirm it in a native dialog first (`picked_paths` in src-tauri), so it
 * can be refused: the field then goes back to what is stored, and the refusal
 * is reported like any other failed command.
 */
const saveLaunch = (patch: GamePreferencesPatch, restore: () => void) =>
  ipc.run(
    ipc
      .settle({ kind: "Settings", command: { type: "patchGame", payload: { patch } } })
      .catch((error: unknown) => {
        restore();
        throw error;
      }),
  );

export function GameSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.game);
  const rawArguments = preferences.additionalArguments ?? [];
  const [argumentsText, setArgumentsText] = useState(rawArguments.join("\n"));
  const persistedText = rawArguments.join("\n");

  useEffect(() => setArgumentsText(persistedText), [persistedText]);

  const commitArguments = () => {
    if (argumentsText === persistedText) return;
    saveLaunch(
      {
        additionalArguments: argumentsText.split(/\r?\n/).map((argument) => argument.trim()).filter(Boolean),
      },
      () => setArgumentsText(persistedText),
    );
  };

  const setAutoGenerate = (autoGenerateMaps: boolean) => {
    void save({ autoGenerateMaps });
  };

  const setConfirmDownloads = (confirmDownloadsBeforeJoining: boolean) => {
    void save({ confirmDownloadsBeforeJoining });
  };

  const [wrapperText, setWrapperText] = useState(preferences.launchWrapper ?? "");
  const persistedWrapper = preferences.launchWrapper ?? "";
  useEffect(() => setWrapperText(persistedWrapper), [persistedWrapper]);
  const commitWrapper = () => {
    if (wrapperText.trim() === persistedWrapper) return;
    // Then the runtime is asked again: an emptied field means the client's own
    // Wine environment is wanted now, and a filled one that it is not.
    ipc.run(
      ipc
        .settle({ kind: "Settings", command: { type: "patchGame", payload: { patch: { launchWrapper: wrapperText.trim() } } } })
        .then(() => ipc.send({ kind: "LinuxRuntime", command: { type: "prepare" } }))
        .catch((error: unknown) => {
          setWrapperText(persistedWrapper);
          throw error;
        }),
    );
  };

  const setPipeLiveReplay = (pipeLiveReplay: boolean) => {
    void save({ pipeLiveReplay });
  };

  return (
    <>
      {/* First, because it is the one switch here that changes what a
          double-click does. The dialog it controls carries its own "do not ask
          again", which is what most people will use to turn it off; this row
          is how they turn it back on. */}
      <SettingRow
        label={t("settings.game.confirmDownloads")}
        hint={t("settings.game.confirmDownloadsHint")}
      >
        <SettingsSwitch
          checked={preferences.confirmDownloadsBeforeJoining ?? true}
          onChange={setConfirmDownloads}
          label={t("settings.game.confirmDownloads")}
        />
      </SettingRow>

      {/* The two progress windows. Each carries its own "do not show again",
          which is what turns it off; these rows are how it comes back. */}
      <SettingRow
        label={t("settings.game.showJoinProgress")}
        hint={t("settings.game.showJoinProgressHint")}
      >
        <SettingsSwitch
          checked={preferences.showJoinProgress ?? true}
          onChange={(showJoinProgress) => void save({ showJoinProgress })}
          label={t("settings.game.showJoinProgress")}
        />
      </SettingRow>

      <SettingRow
        label={t("settings.game.showReplayProgress")}
        hint={t("settings.game.showReplayProgressHint")}
      >
        <SettingsSwitch
          checked={preferences.showReplayProgress ?? true}
          onChange={(showReplayProgress) => void save({ showReplayProgress })}
          label={t("settings.game.showReplayProgress")}
        />
      </SettingRow>

      <SettingRow label={t("settings.game.autoGenerateMaps")}>
        <SettingsSwitch
          checked={preferences.autoGenerateMaps ?? true}
          onChange={setAutoGenerate}
          label={t("settings.game.autoGenerateMaps")}
        />
      </SettingRow>


      {/* Windows only: on Linux the game is a Wine window, and the window
          manager there has its own answer (#445). */}
      {runsOnWindows() && (
        <SettingRow
          label={t("settings.game.borderlessWindow")}
          hint={t("settings.game.borderlessWindowHint")}
        >
          <SettingsSwitch
            checked={preferences.borderlessWindow ?? false}
            onChange={(borderlessWindow) => void save({ borderlessWindow })}
            label={t("settings.game.borderlessWindow")}
          />
        </SettingRow>
      )}

      <SettingRow
        label={t("settings.game.pipeLiveReplay")}
        hint={t("settings.game.pipeLiveReplayHint")}
      >
        <SettingsSwitch
          checked={preferences.pipeLiveReplay ?? false}
          onChange={setPipeLiveReplay}
          label={t("settings.game.pipeLiveReplay")}
        />
      </SettingRow>

      {/* Above the arguments, because it decides what runs them. Only where
          the game is not a native binary: on Windows there is nothing to wrap
          and an empty field labelled "launch command" invites somebody to
          fill it in. */}
      {gameNeedsALaunchWrapper() && <LinuxRuntimeSettings />}

      {gameNeedsALaunchWrapper() && (
        <div className="setting-block">
          <span className="setting-label">{t("settings.game.launchWrapperLabel")}</span>
          <span className="muted">{t("settings.game.launchWrapperHint")}</span>
          <input
            className="settings-input"
            type="text"
            value={wrapperText}
            onChange={(event) => setWrapperText(event.target.value)}
            onBlur={commitWrapper}
            aria-label={t("settings.game.launchWrapperLabel")}
          />
          <div className="settings-save-line">
            <span className="muted">{t("settings.game.launchWrapperNote")}</span>
            <Button onClick={commitWrapper} disabled={wrapperText.trim() === persistedWrapper}>
              {t("settings.game.saveArguments")}
            </Button>
          </div>
        </div>
      )}

      <div className="setting-block">
        <span className="setting-label">{t("settings.game.argumentsLabel")}</span>
        <span className="muted">
          {t("settings.game.argumentsHint")}
        </span>
        <textarea
          className="settings-textarea"
          value={argumentsText}
          onChange={(event) => setArgumentsText(event.target.value)}
          onBlur={commitArguments}
          rows={4}
          placeholder={"/windowed\n/size\n1920\n1080"}
          aria-label={t("settings.game.additionalGameLaunch")}
        />
        <div className="settings-save-line">
          <span className="muted">{t("settings.game.argumentsNote")}</span>
          <Button onClick={commitArguments} disabled={argumentsText === persistedText}>{t("settings.game.saveArguments")}</Button>
        </div>
      </div>
    </>
  );
}
