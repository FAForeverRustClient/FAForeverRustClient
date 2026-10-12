import { useEffect, useMemo, useState } from "react";
import type { GeneratorOptions, MapGeneratorState } from "../../ipc/bindings";
import { isUsablePresetName } from "../../shared/generatorPresets";
import { savePreset } from "./generatorCommands";

export function useGeneratorPresets(state: MapGeneratorState, form: GeneratorOptions, replace: (options: GeneratorOptions) => void) {
  const [saved, setSaved] = useState(false);
  const [presetName, setPresetName] = useState("");
  const presets = useMemo(() => state.presets ?? [], [state.presets]);
  const trimmedPreset = presetName.trim();
  // Matching is case-insensitive because the file name is: saving "ladder"
  // over "Ladder" replaces it rather than making a second entry.
  const existing = presets.find(
    (preset) => preset.name.toLowerCase() === trimmedPreset.toLowerCase(),
  );
  const presetNameUsable = isUsablePresetName(trimmedPreset);

  // "Saved" is an outcome, not a click, and it is this save's outcome: the
  // backend answers every save with `presetSaveFinished` naming the request.
  // It used to be read off a new list that held the name, which an unrelated
  // refresh after a failed overwrite satisfied with the old preset.
  const [pendingSave, setPendingSave] = useState<number | null>(null);
  const save = () => {
    if (!presetNameUsable) return;
    setSaved(false);
    setPendingSave(savePreset(trimmedPreset, form));
  };
  const presetSave = state.presetSave;
  useEffect(() => {
    if (pendingSave === null || presetSave?.requestId !== pendingSave) return;
    setPendingSave(null);
    setSaved(presetSave.saved);
  }, [pendingSave, presetSave]);
  // Its own effect, so clearing the pending request above cannot cancel it.
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2000);
    return () => clearTimeout(timer);
  }, [saved]);

  const applyPreset = (name: string) => {
    const preset = presets.find((entry) => entry.name === name);
    if (!preset) return;
    replace(preset.options);
    setPresetName(preset.name);
  };

  return { presets, existing, saved, presetName, setPresetName, presetNameUsable, save, applyPreset };
}
