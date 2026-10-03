// Every command the generator dialog sends, named, so the dialog reads as
// what it asks for rather than as IPC envelopes.

import type { GenerationType, GeneratorOptions, MapGeneratorCommand } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import type { MessageKey } from "../../i18n";

/** Labels from the Java client's `game.generateMap.*` strings. */
export const GENERATION_TYPES = {
  casual: { label: "maps.generate.kind.casual", hint: "maps.generate.kind.casualHint" },
  tournament: { label: "maps.generate.kind.tournament", hint: "maps.generate.kind.tournamentHint" },
  blind: { label: "maps.generate.kind.blind", hint: "maps.generate.kind.blindHint" },
  unexplored: { label: "maps.generate.kind.unexplored", hint: "maps.generate.kind.unexploredHint" },
} as const satisfies Record<GenerationType, { label: MessageKey; hint: MessageKey }>;

const send = (command: MapGeneratorCommand) => ipc.send({ kind: "MapGenerator", command });

export const generate = (options: GeneratorOptions) => send({ type: "generate", payload: { options } });
export const generateNamed = (mapName: string) => send({ type: "generateNamed", payload: { mapName } });
export const loadOptions = (version?: string | null) =>
  send({ type: "loadOptions", payload: { version: version ?? null } });
export const setOptions = (options: GeneratorOptions) =>
  send({ type: "setOptions", payload: { options } });
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
export const deletePreset = (name: string) => send({ type: "deletePreset", payload: { name } });
export const preflight = (options: GeneratorOptions) => send({ type: "preflight", payload: { options } });
export const decodeNames = (mapNames: string[]) => send({ type: "decodeNames", payload: { mapNames } });
export const loadHelp = (version?: string | null) =>
  send({ type: "loadHelp", payload: { version: version ?? null } });
export const cancel = () => send({ type: "cancel" });
