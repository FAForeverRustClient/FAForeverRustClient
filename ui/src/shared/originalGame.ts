// The original Supreme Commander: Forged Alliance, as the player points the
// client at it: one picker for the missing-install banner and the Original
// game row in Settings, Paths, so both ask the same question the same way.
//
// FAF never launches or writes to this folder. It takes the game's movies,
// sounds, fonts and engine libraries from it, which is why a client that
// cannot find it says so before the first game (see `ResolvedPaths` in
// faf-domain).

import { ipc } from "../ipc/client";
import { native } from "../ipc/native";
import { t } from "../i18n";

/**
 * Ask for the game's folder. Opens where the game was last found, if
 * anywhere.
 *
 * Uses the standalone `t`: the dialog title is produced at click time and
 * needs the language current then.
 */
export function pickOriginalGameFolder(current?: string): Promise<string | null> {
  return native.selectFile({
    title: t("settings.paths.originalGamePickTitle"),
    directory: true,
    defaultPath: current || undefined,
  });
}

/**
 * Remember the folder. The backend re-checks every path after the change,
 * which is what clears the banner once the folder holds the game.
 */
export function setOriginalGameDir(path: string): Promise<void> {
  return ipc.dispatch({
    kind: "Settings",
    command: { type: "patchPaths", payload: { patch: { originalGameDir: path } } },
  });
}
