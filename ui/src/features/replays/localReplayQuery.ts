import type { LocalReplay } from "../../ipc/bindings";

export type LocalReplaySortField = "date" | "title" | "map" | "players" | "size";
export type LocalReplayStatusFilter = "all" | LocalReplay["status"];

export interface LocalReplayQuery {
  player: string;
  exactPlayer: boolean;
  map: string;
  replayId: string;
  mod: string;
  title: string;
  recorder: string;
  simMod: string;
  minRating: number | null;
  maxRating: number | null;
  after: string;
  before: string;
  status: LocalReplayStatusFilter;
  onlyWatchable: boolean;
  sortBy: LocalReplaySortField;
  sortDescending: boolean;
}

export const EMPTY_LOCAL_REPLAY_QUERY: LocalReplayQuery = {
  player: "",
  exactPlayer: false,
  map: "",
  replayId: "",
  mod: "",
  title: "",
  recorder: "",
  simMod: "",
  minRating: null,
  maxRating: null,
  after: "",
  before: "",
  status: "all",
  onlyWatchable: false,
  sortBy: "date",
  sortDescending: true,
};

export function personalLocalReplayQuery(player: string): LocalReplayQuery {
  return player
    ? { ...EMPTY_LOCAL_REPLAY_QUERY, player, exactPlayer: true }
    : { ...EMPTY_LOCAL_REPLAY_QUERY };
}

export function localReplayTimestamp(replay: LocalReplay): number {
  return (replay.startTime ?? replay.modifiedTime) * 1000;
}

function contains(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

function dateBoundary(value: string, endOfDay: boolean): number | null {
  if (!value) return null;
  const suffix = endOfDay ? "T23:59:59.999" : "T00:00:00.000";
  const parsed = new Date(`${value}${suffix}`).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function playerCount(replay: LocalReplay): number {
  return replay.numPlayers || replay.teams.reduce((sum, team) => sum + team.players.length, 0);
}

export function filterLocalReplays(
  replays: LocalReplay[],
  query: LocalReplayQuery,
  mapDisplayName: (replay: LocalReplay) => string = (replay) => replay.map,
): LocalReplay[] {
  const targetPlayers = query.player
    .split(",")
    .map((p) => p.trim().toLocaleLowerCase())
    .filter(Boolean);
  const replayId = query.replayId.trim().replace(/^#/, "");
  const after = dateBoundary(query.after, false);
  const before = dateBoundary(query.before, true);

  const filtered = replays.filter((replay) => {
    const players = replay.teams.flatMap((team) => team.players);
    const matchesPlayer = targetPlayers.length === 0 || targetPlayers.every((target) =>
      players.some((player) => {
        const normalized = player.name.toLocaleLowerCase();
        return query.exactPlayer ? normalized === target : normalized.includes(target);
      })
    );
    const timestamp = localReplayTimestamp(replay);
    return matchesPlayer
      && (!query.map || contains(replay.map, query.map) || contains(mapDisplayName(replay), query.map))
      && (!replayId || replay.uid !== null && String(replay.uid).includes(replayId))
      && (!query.mod || contains(replay.modName, query.mod))
      && (!query.title || contains(replay.title || replay.fileName, query.title))
      && (!query.recorder || contains(replay.recorder, query.recorder))
      && (!query.simMod || replay.simMods.some((mod) => contains(mod, query.simMod)))
      && (query.minRating === null || replay.averageRating !== null && replay.averageRating >= query.minRating)
      && (query.maxRating === null || replay.averageRating !== null && replay.averageRating <= query.maxRating)
      && (query.status === "all" || replay.status === query.status)
      && (!query.onlyWatchable || replay.watchable)
      && (after === null || timestamp >= after)
      && (before === null || timestamp <= before);
  });

  const direction = query.sortDescending ? -1 : 1;
  return filtered.slice().sort((left, right) => {
    let comparison = 0;
    switch (query.sortBy) {
      case "title": comparison = (left.title || left.fileName).localeCompare(right.title || right.fileName); break;
      case "map": comparison = mapDisplayName(left).localeCompare(mapDisplayName(right)); break;
      case "players": comparison = playerCount(left) - playerCount(right); break;
      case "size": comparison = left.fileSizeBytes - right.fileSizeBytes; break;
      case "date": comparison = localReplayTimestamp(left) - localReplayTimestamp(right); break;
    }
    return comparison * direction;
  });
}

export function localReplayAdvancedFilterCount(query: LocalReplayQuery): number {
  return [
    query.exactPlayer,
    query.title !== "",
    query.recorder !== "",
    query.simMod !== "",
    query.after !== "" || query.before !== "",
    query.onlyWatchable,
  ].filter(Boolean).length;
}
