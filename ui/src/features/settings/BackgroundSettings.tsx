// A picture of the player's own behind the interface (#439).
//
// The file is copied into the client's data directory on pick, the same way a
// notification sound is, and only its stored name goes in the settings: see
// `infra::backgrounds`. `useAppBackground` in `App` is what draws it.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { StatusNotice } from "../../design-system/StatusNotice";
import type { AppearancePreferencesPatch } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { BACKGROUND_EXTENSIONS } from "../../shared/appBackground";
import { plainError } from "../../shared/plainError";
import { SettingRow } from "./SettingControls";

const save = (patch: AppearancePreferencesPatch) =>
  ipc.send({ kind: "Settings", command: { type: "patchAppearance", payload: { patch } } });

export function BackgroundSettings() {
  const { t } = useTranslation();
  const image = useAppStore((state) => state.state.settings.appearance.backgroundImage);
  const dim = useAppStore((state) => state.state.settings.appearance.backgroundDim);
  // The slider moves locally and is saved when it is let go: every step of a
  // drag would otherwise be a settings write.
  const [draftDim, setDraftDim] = useState(dim);
  // The copy that failed: the shell's reason, and the picked file, so Retry
  // copies the same picture again instead of opening the picker a second time.
  const [failure, setFailure] = useState<{ reason: string; path: string } | null>(null);
  useEffect(() => setDraftDim(dim), [dim]);

  const importPicked = (path: string) => {
    ipc.run((async () => {
      try {
        const stored = await native.importBackgroundImage(path);
        setFailure(null);
        save({ backgroundImage: stored });
      } catch (reason) {
        setFailure({ reason: String(reason), path });
      }
    })());
  };

  const pick = () => {
    ipc.run((async () => {
      const picked = await native.selectFile({
        title: t("settings.appearance.backgroundPickTitle"),
        filters: [{ name: t("settings.appearance.backgroundPickFilter"), extensions: [...BACKGROUND_EXTENSIONS] }],
      });
      if (picked !== null) importPicked(picked);
    })());
  };

  const commitDim = () => {
    if (draftDim !== dim) save({ backgroundDim: draftDim });
  };

  return (
    <>
      <SettingRow label={t("settings.appearance.background")} hint={t("settings.appearance.backgroundHint")}>
        <div className="settings-background-actions">
          <Button onClick={pick}>{t(image ? "settings.appearance.backgroundChange" : "settings.appearance.backgroundPick")}</Button>
          {image && <Button onClick={() => save({ backgroundImage: "" })}>{t("settings.appearance.backgroundRemove")}</Button>}
        </div>
      </SettingRow>
      {/* Plainly, with the shell's own words ("could not copy C:\...: ...")
          on hover for a bug report. */}
      {failure && (
        <StatusNotice
          tone="error"
          className="settings-inline-notice"
          action={{ label: t("common.retry"), onClick: () => importPicked(failure.path) }}
          detail={failure.reason}
        >
          {plainError(failure.reason)}
        </StatusNotice>
      )}
      {image && (
        <SettingRow label={t("settings.appearance.backgroundDim")} hint={t("settings.appearance.backgroundDimHint")}>
          <div className="settings-background-dim">
            <input
              type="range"
              min={0}
              max={90}
              step={5}
              value={draftDim}
              aria-label={t("settings.appearance.backgroundDim")}
              onChange={(event) => setDraftDim(Number(event.target.value))}
              onPointerUp={commitDim}
              onKeyUp={commitDim}
              onBlur={commitDim}
            />
            <span className="muted">{t("settings.appearance.backgroundDimValue", { percent: draftDim })}</span>
          </div>
        </SettingRow>
      )}
    </>
  );
}
