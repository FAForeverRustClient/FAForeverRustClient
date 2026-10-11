// Name and save a map generator preset from options that came from somewhere
// other than the Generate map dialog: today, the settings read back out of a
// generated map's name in the lobby's map preview (#421).
//
// The save itself is the dialog's own flow, the same `savePreset` command and
// the same per-request outcome, so a preset saved here is indistinguishable
// from one saved there and shows up in the dialog's preset list.

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import type { GeneratorOptions } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { useAppStore } from "../../store/store";
import { MAX_PRESET_NAME, isUsablePresetName, loadPresets, savePreset } from "../generatorPresets";
import "./save-generator-preset-form.css";

export function SaveGeneratorPresetForm({
  options,
  onDone,
}: {
  options: GeneratorOptions;
  /** Called after a successful save and on cancel. */
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const presets = useAppStore((s) => s.state.mapGenerator.presets);
  const presetSave = useAppStore((s) => s.state.mapGenerator.presetSave);
  const [name, setName] = useState("");
  const [pending, setPending] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  // The library is only read when the Generate map dialog opens, so without
  // this a name already taken would not be offered as "Replace".
  useEffect(() => {
    void loadPresets();
  }, []);

  const trimmed = name.trim();
  const usable = isUsablePresetName(trimmed);
  // Case-insensitive, as the file name is: see `preset_file_name`.
  const existing = useMemo(
    () => (presets ?? []).some((preset) => preset.name.toLowerCase() === trimmed.toLowerCase()),
    [presets, trimmed],
  );

  // Done is this request's answer, never a refreshed list that happens to
  // hold the name: the same rule the dialog follows.
  useEffect(() => {
    if (pending === null || presetSave?.requestId !== pending) return;
    setPending(null);
    if (presetSave.saved) onDone();
    else setFailed(true);
  }, [pending, presetSave, onDone]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!usable || pending !== null) return;
    setFailed(false);
    setPending(savePreset(trimmed, options));
  };

  return (
    <form className="save-generator-preset-form" onSubmit={submit}>
      <input
        className="save-generator-preset-input"
        value={name}
        maxLength={MAX_PRESET_NAME}
        autoFocus
        aria-label={t("maps.generate.presetName")}
        placeholder={t("maps.generate.presetName")}
        onChange={(event) => setName(event.target.value)}
      />
      <Button type="submit" variant="primary" disabled={!usable || pending !== null}>
        {existing ? t("maps.generate.presetReplace") : t("maps.generate.presetSave")}
      </Button>
      <Button onClick={onDone}>{t("maps.generate.presetFromMapCancel")}</Button>
      {failed && (
        <p className="save-generator-preset-error" role="alert">
          {t("maps.generate.presetFromMapFailed")}
        </p>
      )}
    </form>
  );
}
