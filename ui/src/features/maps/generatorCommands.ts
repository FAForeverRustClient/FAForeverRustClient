// Every command the generator dialog sends, named, so the dialog reads as
// what it asks for rather than as IPC envelopes.

import type { GenerationType, GeneratorOptions, MapGeneratorCommand } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import type { MessageKey } from "../../i18n";
import { useAppStore } from "../../store/store";
import { stillRunning } from "./GeneratorProgress";

/** Labels from the Java client's `game.generateMap.*` strings. */
export const GENERATION_TYPES = {
  casual: { label: "maps.generate.kind.casual", hint: "maps.generate.kind.casualHint" },
  tournament: { label: "maps.generate.kind.tournament", hint: "maps.generate.kind.tournamentHint" },
  blind: { label: "maps.generate.kind.blind", hint: "maps.generate.kind.blindHint" },
  unexplored: { label: "maps.generate.kind.unexplored", hint: "maps.generate.kind.unexploredHint" },
} as const satisfies Record<GenerationType, { label: MessageKey; hint: MessageKey }>;

const send = (command: MapGeneratorCommand) => ipc.send({ kind: "MapGenerator", command });

// The run this client asked for last, kept so its failure can be sent again
// from wherever it is read.
//
// The dialog offers Retry for its own run while it is open, but a run is slow
// enough that the dialog is usually closed long before it fails, and the Maps
// tab, where the failure is then read, cannot tell from the status what was
// asked for: the status names no command, and runs are also started from a
// replay's details, a lobby joining a generated map and the launcher. So the
// command is remembered as it is sent, together with how many runs had begun
// by then. It is the command of the run on screen only while exactly one run
// has begun since; a run started anywhere else in between leaves it unknown,
// and the failure is shown without Retry rather than with one that sends the
// wrong thing.

/** Runs that have begun since the first one was sent from here. */
let runsBegun = 0;
let watching = false;
let lastRun: { command: MapGeneratorCommand; begunBefore: number } | null = null;

/** Count runs as they begin: the status turning busy from anything that is not. */
function watchRuns() {
  if (watching) return;
  watching = true;
  useAppStore.subscribe((store, previous) => {
    const now = store.state.mapGenerator.status;
    const before = previous.state.mapGenerator.status;
    if (now !== before && stillRunning(now) && !stillRunning(before)) runsBegun += 1;
  });
}

/** Send a run, remembered as the one a failure can send again. */
export function startRun(command: MapGeneratorCommand) {
  watchRuns();
  lastRun = { command, begunBefore: runsBegun };
  send(command);
}

/**
 * The command that started the run the status describes, when it was sent
 * from here and no other run has begun since. Null when that is not known.
 */
export function commandOfCurrentRun(): MapGeneratorCommand | null {
  return lastRun !== null && runsBegun === lastRun.begunBefore + 1 ? lastRun.command : null;
}

export const generate = (options: GeneratorOptions) => startRun({ type: "generate", payload: { options } });
export const generateNamed = (mapName: string) => startRun({ type: "generateNamed", payload: { mapName } });
export const loadOptions = (version?: string | null) =>
  send({ type: "loadOptions", payload: { version: version ?? null } });
export const setOptions = (options: GeneratorOptions) =>
  send({ type: "setOptions", payload: { options } });
// Saving lives in shared/ because the lobby's map preview saves presets too,
// and both must draw request ids from the same counter.
export { loadPresets, savePreset } from "../../shared/generatorPresets";
export const deletePreset = (name: string) => send({ type: "deletePreset", payload: { name } });
export const preflight = (options: GeneratorOptions) => send({ type: "preflight", payload: { options } });
export const decodeNames = (mapNames: string[]) => send({ type: "decodeNames", payload: { mapNames } });
export const loadHelp = (version?: string | null) =>
  send({ type: "loadHelp", payload: { version: version ?? null } });
export const cancel = () => send({ type: "cancel" });
