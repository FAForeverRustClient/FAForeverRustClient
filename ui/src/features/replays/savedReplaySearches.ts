// User-saved search presets for the online replay vault and local replay
// archive.
//
// Inspired by the Java client's saved replay queries (`VaultPrefs.savedReplayQueries`,
// `SaveQueryController` and `SavedQueriesController`), with two deliberate
// differences:
//
//   1. Queries are stored as structured JSON per list (`"replays.online"` and
//      `"replays.local"`) rather than raw RSQL strings, so applying a preset
//      populates every form field, slider, tag picker and sort order instead of
//      dropping text into a raw query box, and works identically in the local
//      archive (where the Java client forgot to wire `setSavedQueries`).
//   2. Missing fields fall back to the list's default query on decode, so
//      presets saved today keep working when new filters are added later.
//   3. A date bound the panel computed from today ("Recent only", "My
//      replays", "Best reviewed") is saved as that many days, not as the date:
//      a search saved as "the last year" still means the last year next spring.

import type {
  RatingLeaderboard,
  ReplayNote,
  ReplayQuery,
  ReplaySortField,
  SearchPreset,
} from "../../ipc/bindings";
import { t, type MessageKey } from "../../i18n";
import { factionLabel } from "../../shared/factions";
import { kilometres } from "../../shared/mapPresentation";
import {
  ALL_TIME_AFTER,
  COOP_FEATURED_MOD,
  EMPTY_REPLAY_QUERY,
  isoDaysAgo,
} from "../../shared/replayQuery";
import { replayIdsTagged } from "../../shared/rules/replayNotes";
import { localGameModes, type LocalGameMode } from "./local/localGameModes";
import {
  EMPTY_LOCAL_REPLAY_QUERY,
  type LocalReplayQuery,
  type LocalReplaySortField,
  type LocalReplayStatusFilter,
} from "./local/localReplayQuery";
import { replayGameModes, selectedGameModes } from "./online/replayGameModes";
import { SHORT_GAME_MINUTES } from "./replayPresets";

export const ONLINE_REPLAY_PRESET_LIST = "replays.online";
export const LOCAL_REPLAY_PRESET_LIST = "replays.local";

const VALID_ONLINE_SORTS: readonly ReplaySortField[] = [
  "startTime",
  "endTime",
  "duration",
  "reviewScore",
  "title",
  "id",
  "victoryCondition",
  "averageRating",
];

const ONLINE_SORT_LABELS: Record<ReplaySortField, MessageKey> = {
  startTime: "replays.search.sort.datePlayed",
  endTime: "replays.search.sort.dateFinished",
  duration: "replays.search.sort.duration",
  reviewScore: "replays.search.sort.reviewScore",
  title: "replays.search.sort.gameTitle",
  id: "replays.search.sort.replayId",
  victoryCondition: "replays.search.sort.victoryCondition",
  averageRating: "replays.search.sort.averageRating",
};

const VALID_LOCAL_SORTS: readonly LocalReplaySortField[] = [
  "date",
  "title",
  "map",
  "players",
  "size",
];

const LOCAL_SORT_LABELS: Record<LocalReplaySortField, MessageKey> = {
  date: "replays.search.sort.datePlayed",
  title: "replays.search.sort.gameTitle",
  map: "replays.search.sort.mapName",
  players: "replays.search.sort.playerCount",
  size: "replays.search.sort.fileSize",
};

const VALID_LOCAL_MODES: readonly LocalGameMode[] = ["", "custom", "ladder_1v1", "coop"];

const VALID_LOCAL_STATUSES: readonly LocalReplayStatusFilter[] = [
  "all",
  "complete",
  "unread",
  "incomplete",
  "legacy",
  "broken",
];

const LOCAL_STATUS_LABELS: Record<LocalReplayStatusFilter, MessageKey> = {
  all: "replays.search.status.all",
  complete: "replays.search.status.complete",
  unread: "replays.local.status.unread",
  incomplete: "replays.search.status.incomplete",
  legacy: "replays.search.status.legacy",
  broken: "replays.search.status.broken",
};

const GAME_TYPE_LABELS: Readonly<Record<string, MessageKey>> = {
  faf: "lobby.host.mod.faf",
  fafbeta: "lobby.host.mod.fafbeta",
  fafdevelop: "lobby.host.mod.fafdevelop",
  nomads: "lobby.host.mod.nomads",
};

const VICTORY_LABELS: Readonly<Record<string, MessageKey>> = {
  DEMORALIZATION: "replays.filters.victory.assassination",
  DOMINATION: "replays.filters.victory.supremacy",
  ERADICATION: "replays.filters.victory.annihilation",
  SANDBOX: "replays.filters.victory.sandbox",
};

/**
 * The windows the search panels compute from today: one year ("Recent only",
 * "My replays", the local archive's "Last year") and three years ("Best
 * reviewed"). An `after` equal to one of them, on the day it is saved, is
 * kept as its day count.
 */
const RELATIVE_AFTER_DAYS = [365, 365 * 3] as const;
const MAX_AFTER_DAYS = 365 * 100;

function relativeAfterDays(after: string): number | null {
  return RELATIVE_AFTER_DAYS.find((days) => isoDaysAgo(days) === after) ?? null;
}

/** `after` with a computed window swapped for its day count. */
function withRelativeAfter(payload: Record<string, unknown>, after: string) {
  const days = relativeAfterDays(after);
  if (days === null) return;
  delete payload.after;
  payload.afterDays = days;
}

function readAfter(record: Record<string, unknown>, fallback: string): string {
  const days = record.afterDays;
  if (typeof days === "number" && Number.isInteger(days) && days > 0 && days <= MAX_AFTER_DAYS) {
    return isoDaysAgo(days);
  }
  return readString(record, "after", fallback);
}

/** How a date bound reads in a summary: a window by name, a date as it is. */
function afterSummary(after: string): string {
  const days = relativeAfterDays(after);
  if (days === 365) return t("replays.search.preset.lastYear");
  if (days === 365 * 3) return t("replays.search.presetsSummaryLastThreeYears");
  return t("replays.search.presetsSummaryAfter", { date: after });
}

export interface DecodedOnlineReplayPreset {
  query: ReplayQuery;
  tags: string[];
}

export function presetsForList(presets: readonly SearchPreset[], list: string): SearchPreset[] {
  const target = list.trim().toLowerCase();
  return presets.filter((preset) => preset.list.trim().toLowerCase() === target);
}

export function findPresetByName(
  presets: readonly SearchPreset[],
  name: string,
): SearchPreset | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  return presets.find((preset) => preset.name.trim().toLowerCase() === wanted) ?? null;
}

function parseRecord(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown>, key: string, fallback: string): string {
  return typeof record[key] === "string" ? record[key] : fallback;
}

function readBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof record[key] === "boolean" ? record[key] : fallback;
}

function readNullableNumber(
  record: Record<string, unknown>,
  key: string,
  fallback: number | null,
): number | null {
  const value = record[key];
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readStringList(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function readNumberList(record: Record<string, unknown>, key: string): number[] {
  const value = record[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry));
}

export function encodeOnlineReplayPreset(query: ReplayQuery, tags: readonly string[]): string {
  const activeTags = (query.replayIds ?? []).length > 0 ? [...tags] : [];
  const payload: Record<string, unknown> = {
    ...query,
    tags: activeTags,
  };
  delete payload.page;
  delete payload.pageSize;
  delete payload.replayIds;
  withRelativeAfter(payload, query.after);
  return JSON.stringify(payload);
}

export function decodeOnlineReplayPreset(
  raw: string,
  replayNotes: readonly ReplayNote[],
  pageSize: number,
): DecodedOnlineReplayPreset | null {
  const record = parseRecord(raw);
  if (!record) return null;

  const sortCandidate = readString(record, "sortBy", EMPTY_REPLAY_QUERY.sortBy);
  const sortBy: ReplaySortField = (VALID_ONLINE_SORTS as readonly string[]).includes(sortCandidate)
    ? (sortCandidate as ReplaySortField)
    : EMPTY_REPLAY_QUERY.sortBy;

  const tags = readStringList(record, "tags");
  let replayIds: string[] = [];
  if (tags.length > 0) {
    const resolved = replayIdsTagged(replayNotes, tags);
    // Asking for game 0 matches nothing in the vault while keeping `replayIds`
    // non-empty when every tagged game has since had that tag removed.
    replayIds = resolved.length > 0 ? resolved : ["0"];
  }

  const query: ReplayQuery = {
    player: readString(record, "player", EMPTY_REPLAY_QUERY.player),
    exactPlayer: readBoolean(record, "exactPlayer", EMPTY_REPLAY_QUERY.exactPlayer),
    map: readString(record, "map", EMPTY_REPLAY_QUERY.map),
    mapAuthor: readString(record, "mapAuthor", EMPTY_REPLAY_QUERY.mapAuthor),
    title: readString(record, "title", EMPTY_REPLAY_QUERY.title),
    replayId: readString(record, "replayId", EMPTY_REPLAY_QUERY.replayId),
    replayIds,
    host: readString(record, "host", EMPTY_REPLAY_QUERY.host),
    featuredMods: readStringList(record, "featuredMods"),
    leaderboards: readStringList(record, "leaderboards"),
    factions: readNumberList(record, "factions"),
    victoryConditions: readStringList(record, "victoryConditions"),
    minRating: readNullableNumber(record, "minRating", EMPTY_REPLAY_QUERY.minRating),
    maxRating: readNullableNumber(record, "maxRating", EMPTY_REPLAY_QUERY.maxRating),
    minReviewScore: readNullableNumber(record, "minReviewScore", EMPTY_REPLAY_QUERY.minReviewScore),
    maxReviewScore: readNullableNumber(record, "maxReviewScore", EMPTY_REPLAY_QUERY.maxReviewScore),
    minDurationMinutes: readNullableNumber(
      record,
      "minDurationMinutes",
      EMPTY_REPLAY_QUERY.minDurationMinutes,
    ),
    maxDurationMinutes: readNullableNumber(
      record,
      "maxDurationMinutes",
      EMPTY_REPLAY_QUERY.maxDurationMinutes,
    ),
    mapMinPlayers: readNullableNumber(record, "mapMinPlayers", EMPTY_REPLAY_QUERY.mapMinPlayers),
    mapMaxPlayers: readNullableNumber(record, "mapMaxPlayers", EMPTY_REPLAY_QUERY.mapMaxPlayers),
    minPlayers: readNullableNumber(record, "minPlayers", EMPTY_REPLAY_QUERY.minPlayers),
    maxPlayers: readNullableNumber(record, "maxPlayers", EMPTY_REPLAY_QUERY.maxPlayers),
    mapMinSizeKm: readNullableNumber(record, "mapMinSizeKm", EMPTY_REPLAY_QUERY.mapMinSizeKm),
    mapMaxSizeKm: readNullableNumber(record, "mapMaxSizeKm", EMPTY_REPLAY_QUERY.mapMaxSizeKm),
    rankedMapOnly: readBoolean(record, "rankedMapOnly", EMPTY_REPLAY_QUERY.rankedMapOnly),
    after: readAfter(record, EMPTY_REPLAY_QUERY.after),
    before: readString(record, "before", EMPTY_REPLAY_QUERY.before),
    onlyRanked: readBoolean(record, "onlyRanked", EMPTY_REPLAY_QUERY.onlyRanked),
    sortBy,
    sortDescending: readBoolean(record, "sortDescending", EMPTY_REPLAY_QUERY.sortDescending),
    page: 1,
    pageSize,
  };

  return { query, tags };
}

export function onlinePresetSignature(query: ReplayQuery, tags: readonly string[]): string {
  const activeTags = (query.replayIds ?? []).length > 0
    ? [...tags].map((tag) => tag.trim().toLowerCase()).sort()
    : [];
  return JSON.stringify({
    player: query.player.trim(),
    exactPlayer: query.exactPlayer,
    map: query.map.trim(),
    mapAuthor: query.mapAuthor.trim(),
    title: query.title.trim(),
    replayId: query.replayId.trim(),
    tags: activeTags,
    host: query.host.trim(),
    featuredMods: [...query.featuredMods].sort(),
    leaderboards: [...query.leaderboards].sort(),
    factions: [...query.factions].sort((a, b) => a - b),
    victoryConditions: [...query.victoryConditions].sort(),
    minRating: query.minRating,
    maxRating: query.maxRating,
    minReviewScore: query.minReviewScore,
    maxReviewScore: query.maxReviewScore,
    minDurationMinutes: query.minDurationMinutes,
    maxDurationMinutes: query.maxDurationMinutes,
    mapMinPlayers: query.mapMinPlayers,
    mapMaxPlayers: query.mapMaxPlayers,
    minPlayers: query.minPlayers,
    maxPlayers: query.maxPlayers,
    mapMinSizeKm: query.mapMinSizeKm,
    mapMaxSizeKm: query.mapMaxSizeKm,
    rankedMapOnly: query.rankedMapOnly,
    after: query.after,
    before: query.before,
    onlyRanked: query.onlyRanked,
    sortBy: query.sortBy,
    sortDescending: query.sortDescending,
  });
}

export function encodeLocalReplayPreset(query: LocalReplayQuery): string {
  const payload: Record<string, unknown> = { ...query };
  withRelativeAfter(payload, query.after);
  return JSON.stringify(payload);
}

export function decodeLocalReplayPreset(raw: string): LocalReplayQuery | null {
  const record = parseRecord(raw);
  if (!record) return null;

  const modeCandidate = readString(record, "gameMode", EMPTY_LOCAL_REPLAY_QUERY.gameMode);
  const gameMode: LocalGameMode = (VALID_LOCAL_MODES as readonly string[]).includes(modeCandidate)
    ? (modeCandidate as LocalGameMode)
    : EMPTY_LOCAL_REPLAY_QUERY.gameMode;

  const statusCandidate = readString(record, "status", EMPTY_LOCAL_REPLAY_QUERY.status);
  const status: LocalReplayStatusFilter = (VALID_LOCAL_STATUSES as readonly string[]).includes(
    statusCandidate,
  )
    ? (statusCandidate as LocalReplayStatusFilter)
    : EMPTY_LOCAL_REPLAY_QUERY.status;

  const sortCandidate = readString(record, "sortBy", EMPTY_LOCAL_REPLAY_QUERY.sortBy);
  const sortBy: LocalReplaySortField = (VALID_LOCAL_SORTS as readonly string[]).includes(
    sortCandidate,
  )
    ? (sortCandidate as LocalReplaySortField)
    : EMPTY_LOCAL_REPLAY_QUERY.sortBy;

  return {
    player: readString(record, "player", EMPTY_LOCAL_REPLAY_QUERY.player),
    exactPlayer: readBoolean(record, "exactPlayer", EMPTY_LOCAL_REPLAY_QUERY.exactPlayer),
    map: readString(record, "map", EMPTY_LOCAL_REPLAY_QUERY.map),
    replayId: readString(record, "replayId", EMPTY_LOCAL_REPLAY_QUERY.replayId),
    mod: readString(record, "mod", EMPTY_LOCAL_REPLAY_QUERY.mod),
    gameMode,
    title: readString(record, "title", EMPTY_LOCAL_REPLAY_QUERY.title),
    note: readString(record, "note", EMPTY_LOCAL_REPLAY_QUERY.note),
    tags: readStringList(record, "tags"),
    recorder: readString(record, "recorder", EMPTY_LOCAL_REPLAY_QUERY.recorder),
    simMod: readString(record, "simMod", EMPTY_LOCAL_REPLAY_QUERY.simMod),
    minRating: readNullableNumber(record, "minRating", EMPTY_LOCAL_REPLAY_QUERY.minRating),
    maxRating: readNullableNumber(record, "maxRating", EMPTY_LOCAL_REPLAY_QUERY.maxRating),
    minDurationMinutes: readNullableNumber(
      record,
      "minDurationMinutes",
      EMPTY_LOCAL_REPLAY_QUERY.minDurationMinutes,
    ),
    after: readAfter(record, EMPTY_LOCAL_REPLAY_QUERY.after),
    before: readString(record, "before", EMPTY_LOCAL_REPLAY_QUERY.before),
    status,
    onlyWatchable: readBoolean(record, "onlyWatchable", EMPTY_LOCAL_REPLAY_QUERY.onlyWatchable),
    sortBy,
    sortDescending: readBoolean(
      record,
      "sortDescending",
      EMPTY_LOCAL_REPLAY_QUERY.sortDescending,
    ),
  };
}

export function localPresetSignature(query: LocalReplayQuery): string {
  return JSON.stringify({
    player: query.player.trim(),
    exactPlayer: query.exactPlayer,
    map: query.map.trim(),
    replayId: query.replayId.trim(),
    mod: query.mod.trim(),
    gameMode: query.gameMode,
    title: query.title.trim(),
    note: query.note.trim(),
    tags: [...query.tags].map((tag) => tag.trim().toLowerCase()).sort(),
    recorder: query.recorder.trim(),
    simMod: query.simMod.trim(),
    minRating: query.minRating,
    maxRating: query.maxRating,
    minDurationMinutes: query.minDurationMinutes,
    after: query.after,
    before: query.before,
    status: query.status,
    onlyWatchable: query.onlyWatchable,
    sortBy: query.sortBy,
    sortDescending: query.sortDescending,
  });
}

function formatBounds(
  low: number | null,
  high: number | null,
  formatValue: (value: number) => string = String,
): string | null {
  if (low !== null && high !== null) {
    return low === high
      ? formatValue(low)
      : t("lobby.browser.ratingBetween", { min: formatValue(low), max: formatValue(high) });
  }
  if (low !== null) return `${formatValue(low)}+`;
  if (high !== null) return `<=${formatValue(high)}`;
  return null;
}

export function summarizeOnlineReplayPreset(
  preset: DecodedOnlineReplayPreset,
  leaderboards: RatingLeaderboard[],
): string {
  const { query, tags } = preset;
  const parts: string[] = [];

  if (query.player.trim()) parts.push(query.player.trim());
  if (query.map.trim()) parts.push(query.map.trim());
  if (query.title.trim()) parts.push(`"${query.title.trim()}"`);
  if (query.replayId.trim()) parts.push(`#${query.replayId.trim().replace(/^#/, "")}`);

  const modeCatalog = replayGameModes(leaderboards);
  const pickedModes = selectedGameModes(query).map(
    (id) => modeCatalog.find((mode) => mode.id === id)?.label ?? id,
  );
  if (pickedModes.length > 0) parts.push(pickedModes.join(", "));

  const gameTypes = query.featuredMods
    .filter((mod) => mod !== COOP_FEATURED_MOD)
    .map((mod) => {
      const key = GAME_TYPE_LABELS[mod];
      return key ? t(key) : mod;
    });
  if (gameTypes.length > 0) parts.push(gameTypes.join(", "));

  const rating = formatBounds(query.minRating, query.maxRating);
  if (rating) parts.push(`${t("replays.search.rating")}: ${rating}`);

  if (query.minDurationMinutes === SHORT_GAME_MINUTES && query.maxDurationMinutes === null) {
    parts.push(t("replays.search.hideShort"));
  } else {
    const duration = formatBounds(
      query.minDurationMinutes,
      query.maxDurationMinutes,
      (value) => `${value} min`,
    );
    if (duration) parts.push(duration);
  }

  const players = formatBounds(query.minPlayers, query.maxPlayers);
  if (players) parts.push(`${t("replays.column.players")}: ${players}`);

  const slots = formatBounds(query.mapMinPlayers, query.mapMaxPlayers);
  if (slots) parts.push(`${t("replays.filters.mapSlots")}: ${slots}`);

  const mapSize = formatBounds(query.mapMinSizeKm, query.mapMaxSizeKm, kilometres);
  if (mapSize) parts.push(mapSize);

  const reviews = formatBounds(
    query.minReviewScore,
    query.maxReviewScore,
    (value) => `${value}★`,
  );
  if (reviews) parts.push(reviews);

  if (query.host.trim()) parts.push(`${t("replays.filters.host")}: ${query.host.trim()}`);
  if (query.mapAuthor.trim()) {
    parts.push(`${t("replays.filters.mapAuthor")}: ${query.mapAuthor.trim()}`);
  }
  if (tags.length > 0) parts.push(tags.map((tag) => `#${tag}`).join(", "));
  if (query.factions.length > 0) parts.push(query.factions.map(factionLabel).join(", "));
  if (query.victoryConditions.length > 0) {
    parts.push(
      query.victoryConditions
        .map((condition) => {
          const key = VICTORY_LABELS[condition];
          return key ? t(key) : condition;
        })
        .join(", "),
    );
  }

  if (query.after && query.after !== ALL_TIME_AFTER) parts.push(afterSummary(query.after));
  if (query.before) {
    parts.push(t("replays.search.presetsSummaryBefore", { date: query.before }));
  }
  if (query.onlyRanked) parts.push(t("replays.filters.rankedGamesOnly"));
  if (query.rankedMapOnly) parts.push(t("replays.filters.rankedMapsOnly"));

  const defaultSort =
    query.sortBy === EMPTY_REPLAY_QUERY.sortBy
    && query.sortDescending === EMPTY_REPLAY_QUERY.sortDescending;
  if (!defaultSort || parts.length === 0) {
    const sortText = `${t(ONLINE_SORT_LABELS[query.sortBy])} ${query.sortDescending ? "↓" : "↑"}`;
    if (parts.length === 0) parts.push(t("replays.search.preset.newest"));
    parts.push(sortText);
  }

  return parts.join(" · ");
}

export function summarizeLocalReplayPreset(query: LocalReplayQuery): string {
  const parts: string[] = [];

  if (query.player.trim()) parts.push(query.player.trim());
  if (query.map.trim()) parts.push(query.map.trim());
  if (query.title.trim()) parts.push(`"${query.title.trim()}"`);
  if (query.replayId.trim()) parts.push(`#${query.replayId.trim().replace(/^#/, "")}`);

  if (query.gameMode) {
    const modeLabel =
      localGameModes().find((mode) => mode.id === query.gameMode)?.label ?? query.gameMode;
    parts.push(modeLabel);
  }
  if (query.mod.trim()) parts.push(query.mod.trim());
  if (query.simMod.trim()) parts.push(query.simMod.trim());
  if (query.recorder.trim()) parts.push(`${t("replays.search.recorder")}: ${query.recorder.trim()}`);
  if (query.note.trim()) parts.push(`"${query.note.trim()}"`);
  if (query.tags.length > 0) parts.push(query.tags.map((tag) => `#${tag}`).join(", "));

  const rating = formatBounds(query.minRating, query.maxRating);
  if (rating) parts.push(`${t("replays.search.rating")}: ${rating}`);

  if (query.minDurationMinutes === SHORT_GAME_MINUTES) {
    parts.push(t("replays.search.hideShort"));
  } else {
    const duration = formatBounds(query.minDurationMinutes, null, (value) => `${value} min`);
    if (duration) parts.push(duration);
  }

  if (query.after) parts.push(afterSummary(query.after));
  if (query.before) parts.push(t("replays.search.presetsSummaryBefore", { date: query.before }));
  if (query.status !== "all") parts.push(t(LOCAL_STATUS_LABELS[query.status]));
  if (query.onlyWatchable) parts.push(t("replays.search.watchableOnly"));

  const defaultSort =
    query.sortBy === EMPTY_LOCAL_REPLAY_QUERY.sortBy
    && query.sortDescending === EMPTY_LOCAL_REPLAY_QUERY.sortDescending;
  if (!defaultSort || parts.length === 0) {
    const sortText = `${t(LOCAL_SORT_LABELS[query.sortBy])} ${query.sortDescending ? "↓" : "↑"}`;
    if (parts.length === 0) parts.push(t("replays.search.preset.newest"));
    parts.push(sortText);
  }

  return parts.join(" · ");
}
