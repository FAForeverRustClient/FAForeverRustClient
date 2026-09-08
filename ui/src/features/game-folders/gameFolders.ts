// Every folder the client can reveal, in one list.
//
// The list exists twice on screen: in Settings under Paths, where somebody is
// configuring a directory and wants to look at what they just pointed at, and
// behind the sidebar's Game folders button, which is the quick way in from
// anywhere. It exists once here so those two never disagree about what a
// "client folder" is.

import { native, type ClientFolder, type LogKind } from "../../ipc/native";
import type { MessageKey } from "../../i18n";

/**
 * What opening an entry does.
 *
 * Two shell calls rather than one, because the backend resolves the two kinds
 * of directory differently: a client folder is worked out from the configured
 * paths, a log folder from where this build writes its diagnostics.
 */
export type FolderTarget =
  | { kind: "client"; folder: ClientFolder }
  | { kind: "log"; log: LogKind };

export interface FolderEntry {
  /** Stable id: the React key, and what a test names. */
  id: string;
  label: MessageKey;
  target: FolderTarget;
}

export interface FolderGroup {
  id: "client" | "diagnostics";
  title: MessageKey;
  entries: readonly FolderEntry[];
}

/**
 * The groups, in the order both surfaces draw them.
 *
 * Client folders first: those are the ones somebody opens to drop a map in.
 * The log folders are underneath because they are opened when something has
 * already gone wrong.
 */
export const FOLDER_GROUPS: readonly FolderGroup[] = [
  {
    id: "client",
    title: "settings.folders.label",
    entries: [
      { id: "maps", label: "settings.folders.maps", target: { kind: "client", folder: "maps" } },
      { id: "mods", label: "settings.folders.mods", target: { kind: "client", folder: "mods" } },
      { id: "replays", label: "settings.folders.replays", target: { kind: "client", folder: "replays" } },
      { id: "vault", label: "settings.folders.vault", target: { kind: "client", folder: "vault" } },
      { id: "gameCache", label: "settings.folders.gameCache", target: { kind: "client", folder: "gameCache" } },
      { id: "gamePrefs", label: "settings.folders.gamePrefs", target: { kind: "client", folder: "gamePrefs" } },
    ],
  },
  {
    id: "diagnostics",
    title: "gameFolders.diagnostics",
    entries: [
      { id: "gameLogs", label: "settings.diagnostics.gameLogs", target: { kind: "log", log: "game" } },
      { id: "clientLogs", label: "settings.diagnostics.clientLogs", target: { kind: "log", log: "client" } },
    ],
  },
];

/** Every entry, flattened, for a surface that draws one list. */
export function allFolderEntries(): FolderEntry[] {
  return FOLDER_GROUPS.flatMap((group) => [...group.entries]);
}

/** Ask the shell to reveal one entry. Rejects with the shell's own message. */
export function openFolderEntry(entry: FolderEntry): Promise<void> {
  return entry.target.kind === "client"
    ? native.openClientFolder(entry.target.folder)
    : native.openLogFolder(entry.target.log);
}
