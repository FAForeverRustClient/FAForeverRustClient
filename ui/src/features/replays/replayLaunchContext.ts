// What the replay starting dialog names: the map, the title and the game id
// of the replay being started, decided away from React.
//
// The backend says only which replay it is (a vault id, a live game, a file);
// everything shown about it comes from the lists the client already holds.
// A launch from a list nothing here mirrors (a tournament bracket, a training
// guide) still has its id, so the dialog falls back to that rather than to
// nothing.

import type { Game, LocalReplay, ReplayLaunch, VaultReplay } from "../../ipc/bindings";
import { normalizeReplayPath } from "../../shared/rules/replayReadKey";

export interface ReplayLaunchSources {
  vault: readonly VaultReplay[];
  recentMatchmaker: readonly VaultReplay[];
  liveGames: readonly Game[];
  local: readonly LocalReplay[];
}

export interface ReplayLaunchContext {
  /** The game id, when the replay has one. A local file may not. */
  uid: number | null;
  /** The lobby title, or `null` when no list here knows the replay. */
  title: string | null;
  /** The map's folder name, for its picture. */
  map: string | null;
  /** Art the vault listing already carries for this map. */
  mapUrl: string | null;
  /** The file name, for a local replay. */
  fileName: string | null;
  live: boolean;
}

export function replayLaunchContext(
  launch: ReplayLaunch,
  sources: ReplayLaunchSources,
): ReplayLaunchContext {
  switch (launch.type) {
    case "vault": {
      const { uid } = launch.payload;
      const replay = sources.vault.find((candidate) => candidate.uid === uid)
        ?? sources.recentMatchmaker.find((candidate) => candidate.uid === uid);
      return {
        uid,
        title: replay?.title || null,
        map: replay?.map || null,
        mapUrl: replay?.mapThumbnailUrl || null,
        fileName: null,
        live: false,
      };
    }
    case "live": {
      const { target } = launch.payload;
      const game = sources.liveGames.find((candidate) => candidate.id === target.uid);
      return {
        uid: target.uid,
        title: game?.title || null,
        map: target.map || game?.map || null,
        mapUrl: null,
        fileName: null,
        live: true,
      };
    }
    case "file": {
      const wanted = normalizeReplayPath(launch.payload.path);
      const replay = sources.local.find((candidate) => normalizeReplayPath(candidate.path) === wanted);
      return {
        uid: replay?.uid ?? null,
        title: replay?.title || null,
        map: replay?.map || null,
        mapUrl: null,
        fileName: replay?.fileName ?? fileNameOf(launch.payload.path),
        live: false,
      };
    }
  }
}

function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
