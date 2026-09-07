// Which mission a co-op replay was played on.
//
// The vault knows the map of every game except a co-op one. FAF records a
// game's map as a `map_version` row, and campaign missions are not vault maps:
// they live in their own `coopMission` collection, with their own folders and
// their own artwork. So `game.relationships.mapVersion` is empty for every
// co-op game ever played, and the API listing arrives with no map at all: the
// backend marks that with `UNKNOWN_VAULT_MAP`, and the whole co-op half of
// the Replays tab read "Unknown Map".
//
// The replay file knows, and nothing else does. Its command stream opens with
// the scenario the engine loaded (`/maps/SCCA_Coop_A03.v0023/...`), which is
// the mission's own folder: the same field `faf-scfa-replay-parser` reads.
// Three ways to that answer, in descending order of certainty:
//
// 1. The file on this disk, when the client has it: `effectiveReplayMapName`
//    picks the map up from a matching local replay.
// 2. The file in the vault, read by `ReplayCommand::ResolveMaps`: the first
//    64 KiB of it, which is the envelope and enough of the stream to decode
//    the scenario path. This is the answer for a game the client has never
//    downloaded, and it overrides the guess below as soon as it arrives.
// 3. The mission catalogue, matched against the game's title. Hosting a
//    mission titles the game after it unless the host types over that, so
//    this is a good guess, it costs nothing, and it fills the row while the
//    real answer is still being fetched.
//
// Only a game that is none of those, renamed and unreadable, is left saying
// merely that it was a mission.

import type { CoopMission, VaultMap } from "../../ipc/bindings";
import { t } from "../../i18n";
import {
  isUnknownVaultMap,
  mapPresentation,
  type MapPresentation,
} from "../../shared/mapPresentation";

/** A mission name below this length is too generic to spot inside a title. */
const SHORTEST_MATCHABLE_NAME = 5;

/** Was this game a campaign mission rather than a map? */
export function isCoopReplay(modName: string): boolean {
  return modName.trim().toLocaleLowerCase() === "coop";
}

/** Punctuation and spacing differ between a game title and a mission name. */
function comparable(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim();
}

/**
 * The mission a co-op game's title names, if it names one.
 *
 * An exact title wins outright. Otherwise the longest mission name the title
 * contains wins, so "Operation Fear No Evil" is not decided by a short name
 * that happens to be a fragment of a longer one.
 */
export function coopMissionByTitle(
  title: string,
  missions: CoopMission[],
): CoopMission | undefined {
  const wanted = comparable(title);
  if (!wanted) return undefined;

  let contained: CoopMission | undefined;
  for (const mission of missions) {
    const name = comparable(mission.name);
    if (!name) continue;
    if (name === wanted) return mission;
    if (name.length < SHORTEST_MATCHABLE_NAME) continue;
    if (!wanted.includes(name)) continue;
    if (!contained || comparable(contained.name).length < name.length) contained = mission;
  }
  return contained;
}

/**
 * The map key a replay's name and artwork should be looked up under.
 *
 * The listing's own map when it has one. Otherwise what the replay file said,
 * which is read for any game the listing left blank rather than only for a
 * co-op one: a deleted vault map leaves the same hole. Failing that, and only
 * for co-op, the mission the title names. All three resolve to a map folder,
 * which is the key the vault lookup, the preview service and the mission
 * artwork all use.
 */
export function replayMapKey(
  missions: CoopMission[],
  replay: { map: string; title: string; modName: string },
  resolved?: string,
): string {
  if (!isUnknownVaultMap(replay.map)) return replay.map;
  if (resolved) return resolved;
  if (!isCoopReplay(replay.modName)) return replay.map;
  return coopMissionByTitle(replay.title, missions)?.mapFolderName ?? replay.map;
}

/**
 * How a replay's map should be presented, mission or not.
 *
 * Anything with a map key goes straight to the shared presentation, which
 * already resolves a mission folder to its name and artwork. Only a co-op game
 * that none of the three sources could name reaches the last line, and it says
 * what is still known about it: that it was a mission.
 */
export function replayMapPresentation(
  vault: VaultMap[],
  missions: CoopMission[],
  replay: { map: string; title: string; modName: string },
  resolved?: string,
): MapPresentation {
  const key = replayMapKey(missions, replay, resolved);
  if (!isUnknownVaultMap(key)) return mapPresentation(vault, key, missions);
  if (!isCoopReplay(replay.modName)) return mapPresentation(vault, replay.map, missions);
  return {
    displayName: t("replays.map.coopMission"),
    thumbnailUrl: "",
    thumbnailUrls: [],
    isCoop: true,
  };
}
