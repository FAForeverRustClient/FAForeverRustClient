import { useEffect, useState } from "react";
import type { GamePreferences } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { Button } from "../../design-system/Button";
import { useAppStore } from "../../store/store";
import { GamePathsSection } from "./GamePathsSection";

const save = (preferences: GamePreferences) =>
  ipc.send({ kind: "Settings", command: { type: "setGame", payload: { preferences } } });

export function GameSettingsSection() {
  const preferences = useAppStore((state) => state.state.settings.game);
  const [argumentsText, setArgumentsText] = useState(preferences.additionalArguments.join("\n"));
  const persistedText = preferences.additionalArguments.join("\n");

  useEffect(() => setArgumentsText(persistedText), [persistedText]);

  const commitArguments = () => {
    if (argumentsText === persistedText) return;
    void save({
      ...preferences,
      additionalArguments: argumentsText.split(/\r?\n/).map((argument) => argument.trim()).filter(Boolean),
    });
  };

  return (
    <>
      <GamePathsSection />
      <div className="setting-block">
        <span className="setting-label">Additional launch arguments</span>
        <span className="muted">
          One literal process argument per line. Applied to live games and replay playback without invoking a shell.
        </span>
        <textarea
          className="settings-textarea"
          value={argumentsText}
          onChange={(event) => setArgumentsText(event.target.value)}
          onBlur={commitArguments}
          rows={4}
          placeholder={"/windowed\n/size\n1920\n1080"}
          aria-label="Additional game launch arguments"
        />
        <div className="settings-save-line">
          <span className="muted">Protocol-required arguments are managed by the client.</span>
          <Button onClick={commitArguments} disabled={argumentsText === persistedText}>Save arguments</Button>
        </div>
      </div>
    </>
  );
}
