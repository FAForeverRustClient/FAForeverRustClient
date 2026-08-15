import { useEffect, useState } from "react";
import type { GamePreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { Button } from "../../design-system/Button";
import { useAppStore } from "../../store/store";
import { GamePathsSection } from "./GamePathsSection";
import { useTranslation } from "../../i18n/useTranslation";
import { SettingRow, SettingsSwitch } from "./SettingControls";

const save = (preferences: GamePreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setGame", payload: { preferences } } });

export function GameSettingsSection() {
  const { t } = useTranslation();
  const preferences = useAppStore((state) => state.state.settings.game);
  const rawArguments = preferences.additionalArguments ?? [];
  const [argumentsText, setArgumentsText] = useState(rawArguments.join("\n"));
  const persistedText = rawArguments.join("\n");

  useEffect(() => setArgumentsText(persistedText), [persistedText]);

  const commitArguments = () => {
    if (argumentsText === persistedText) return;
    void save({
      ...preferences,
      additionalArguments: argumentsText.split(/\r?\n/).map((argument) => argument.trim()).filter(Boolean),
    });
  };

  const setAutoGenerate = (autoGenerateMaps: boolean) => {
    void save({ ...preferences, autoGenerateMaps });
  };

  return (
    <>
      <GamePathsSection />
      <SettingRow
        label="Automatically generate missing maps"
        hint="Download the Neroxis generator and create required generated maps automatically when joining a lobby."
      >
        <SettingsSwitch
          checked={preferences.autoGenerateMaps ?? true}
          onChange={setAutoGenerate}
          label="Automatically generate missing maps"
        />
      </SettingRow>
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
