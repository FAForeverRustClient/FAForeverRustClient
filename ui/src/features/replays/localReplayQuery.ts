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
  // Same default as the vault search: a name means that player, not everyone
  // whose name contains it.
  exactPlayer: true,
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

/// How far into the folder the details have to be read for the page on screen.
///
/// The backend lists every replay it finds but only reads the headers of the
/// newest `limit` of them, and the rest arrive as `unread`: a file name, a date
/// and a size, with no title, map or roster. Whether those rows reach the list
/// depends on the query. A player filter drops them, because a replay with no
/// roster matches nobody, so the pager ends where the read files end. With no
/// player filter they are listed like any other, so page 11 of a large archive
/// is reachable, sits well inside the pager, and shows nothing but file names
/// until someone asks for those headers.
///
/// Returns the limit to ask for, or `null` when what is loaded already covers
/// the page. `atLastPage` keeps the older behaviour for the filtered case:
/// arriving at the end of the results asks for the next batch, since there
/// would otherwise be no page to walk onto.
export function nextLocalDetailLimit(options: {
  /// Every replay the backend reported, newest first: that order is what the
  /// read limit counts along.
  all: LocalReplay[];
  /// The replays the current page renders.
  page: LocalReplay[];
  /// How many headers have been asked for so far.
  detailLimit: number;
  atLastPage: boolean;
  batch: number;
}): number | null {
  const { all, page, detailLimit, atLastPage, batch } = options;
  if (detailLimit >= all.length) return null;

  let depth = 0;
  if (page.some((replay) => replay.status === "unread")) {
    const positions = new Map(all.map((replay, index) => [replay.path, index]));
    for (const replay of page) {
      if (replay.status !== "unread") continue;
      const index = positions.get(replay.path);
      if (index !== undefined) depth = Math.max(depth, index + 1);
    }
  }

  if (depth <= detailLimit && !atLastPage) return null;
  return Math.min(all.length, Math.max(depth, detailLimit + batch));
}
