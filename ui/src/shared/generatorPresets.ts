// Saving map generator presets, from wherever a set of options comes from: the
// Generate map dialog's form, or the settings read back out of a generated
// map's name (#421). Shared so both send through the one request counter: two
// counters would hand out the same request id twice, and a save would then be
// reported finished by the answer to a different one.

import type { GeneratorOptions, MapGeneratorCommand } from "../ipc/bindings";
import { ipc } from "../ipc/client";

const send = (command: MapGeneratorCommand) => ipc.send({ kind: "MapGenerator", command });

/** Session-wide, so an answer meant for a dialog since closed matches nothing. */
let nextPresetSave = 1;

/** Save a preset; returns the request id its `presetSaveFinished` will carry. */
export const savePreset = (name: string, options: GeneratorOptions): number => {
  const requestId = nextPresetSave;
  nextPresetSave += 1;
  void send({ type: "savePreset", payload: { name, options, requestId } });
  return requestId;
};

export const loadPresets = () => send({ type: "loadPresets" });

/** Longest name the backend accepts (`MAX_PRESET_NAME` in faf-domain). */
export const MAX_PRESET_NAME = 80;

/**
 * Whether a typed name can become a preset. A quick mirror of the backend's
 * `is_valid_preset_name`, which has the final word: this only keeps the save
 * button from offering what would be refused.
 */
export function isUsablePresetName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed !== "" && trimmed.length <= MAX_PRESET_NAME && /^[\w\- ]+$/.test(trimmed);
}
