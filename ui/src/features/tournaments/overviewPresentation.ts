// The Overview's own rules: the early-stop countdown and the Recent results
// list, as the website's `drawOverview` and `fillQueue` compute them.
//
// Presentation only, so no conformance twin: nothing here decides anything the
// service does not already know. Kept pure so a test can read each rule
// without rendering the page.

import type { MessageKey, MessageValues } from "../../i18n";
import type { Tourney, TourneyMatch } from "../../ipc/bindings";
import { roundKeyOf } from "../../shared/rules/tourneyRules";
import { BRACKET_KIND_LABELS, FORMATION_LABELS, planSummary, typeLine } from "./tourneyPresentation";

type Translate = (key: MessageKey, values?: MessageValues) => string;

/** One fact of the Tournament format panel: a value over its label. */
export interface FormatCell {
  label: MessageKey;
  value: string;
}

/**
 * The event's format as up to three facts: who plays (1v1, 2v2 with drafted
 * captains, a free-for-all of solo players), how the field is cut down (the
 * bracket, or the lobby mode), and how long the matches are. An import carries
 * none of these apart, so it is the one line it has.
 */
export function formatCells(event: Tourney, t: Translate): FormatCell[] {
  if (event.imported) return [{ label: "tournaments.overview.format", value: typeLine(event, t) }];
  const plan = planSummary(event, t);
  const cells: FormatCell[] = [];
  if (event.competition === "freeForAll" && event.ffa !== null) {
    const size =
      event.teamSize === 1
        ? t("tournaments.overview.ffaSolo")
        : t("tournaments.overview.ffaTeams", { size: event.teamSize });
    cells.push({
      label: "tournaments.overview.format",
      value: `${size} · ${t("tournaments.overview.ffaPerLobby", { count: event.ffa.perMatch })}`,
    });
    cells.push({
      label: "tournaments.section.bracket",
      value: t(event.ffa.mode === "points" ? "tournaments.overview.ffaPoints" : "tournaments.overview.ffaKnockout"),
    });
  } else {
    cells.push({
      label: "tournaments.overview.format",
      value:
        event.teamSize === 1
          ? "1v1"
          : `${event.teamSize}v${event.teamSize} · ${t(FORMATION_LABELS[event.formation])}`,
    });
    cells.push({ label: "tournaments.section.bracket", value: t(BRACKET_KIND_LABELS[event.bracketKind]) });
  }
  if (plan !== "") cells.push({ label: "tournaments.overview.matchFormat", value: plan });
  return cells;
}

/** One line of an organiser's settings list, split at its colon. */
export interface SettingRow {
  key: string;
  value: string;
}

/** `Key: value`, with or without a bullet in front; a key is a short name. */
const SETTING_LINE = /^(?:[-*]\s+)?([^:]{1,40}):[*_]*\s+(\S.*)$/;

/** An organiser's settings list, and whatever they wrote around it. */
export interface SettingList {
  rows: SettingRow[];
  /** Lines over the list and under it, as written: an intro, a closing note. */
  before: string;
  after: string;
}

/** A line as a setting, or null where it is something else. */
function settingOf(line: string): SettingRow | null {
  const match = SETTING_LINE.exec(line);
  if (match === null) return null;
  const key = match[1].replace(/^[*_]+|[*_]+$/g, "").trim();
  const value = match[2].trim();
  return key === "" || value === "" ? null : { key, value };
}

/**
 * An organiser's lobby options as rows, where they were written as a list of
 * `Key: value` lines; null where they were not.
 *
 * The service keeps the lobby options as one block of the website's markdown,
 * so nothing says which setting is which. What the organisers write, on every
 * event that has the field, is one setting per line with its name before a
 * colon, and that convention is what is read here. Lines above the first
 * setting and below the last are kept as notes ("All other settings must be
 * left at default" closes the official events' list); anything else between
 * two settings, or a list of fewer than two, means the block is prose and is
 * shown as the prose it is. Emphasis wrapped round the whole name is dropped
 * with it: `**Teams:** Locked` names the setting Teams.
 */
export function settingRows(source: string): SettingList | null {
  const lines = source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const settings = lines.map(settingOf);
  const first = settings.findIndex((setting) => setting !== null);
  const last = settings.length - 1 - [...settings].reverse().findIndex((setting) => setting !== null);
  if (first === -1) return null;
  const rows = settings.slice(first, last + 1);
  if (rows.length < 2 || rows.some((setting) => setting === null)) return null;
  return {
    rows: rows as SettingRow[],
    before: lines.slice(0, first).join("\n"),
    after: lines.slice(last + 1).join("\n"),
  };
}

/**
 * How many entrants are still in: the service's `aliveTeamCount`, which is
 * every team not marked eliminated. The detail does not carry the count, so it
 * is counted here exactly as the server counts it.
 */
export function aliveCount(event: Tourney): number {
  return event.teams.filter((held) => !held.eliminated).length;
}

/**
 * How many eliminations are left before a declared early stop ends the event.
 * Null unless the event is running with a stop set: before the bracket there is
 * nothing to count down, and after it the stop has either happened or no
 * longer can.
 */
export function stopAtRemaining(event: Tourney): number | null {
  if (event.stopAtAlive <= 0 || event.status !== "running") return null;
  return Math.max(0, aliveCount(event) - event.stopAtAlive);
}

/**
 * The latest results, newest round first: the website's eight most recent done
 * matches. Free-for-all lobbies are in it too, because on the website they are.
 */
export function recentResults(event: Tourney): TourneyMatch[] {
  return event.matches
    .filter((entry) => entry.status === "done")
    .sort((left, right) => right.round - left.round || left.index - right.index)
    .slice(0, 8);
}

/**
 * A round's name the way the result list says it: "Round 2", "Semis",
 * "Winners bracket final", "Losers bracket R3". The website's `roundLabel`.
 *
 * Deliberately not `matchLabel`, which is the Matches tab's short code: this is
 * a headline over a result, and reads as one.
 */
export function resultRoundLabel(event: Tourney, entry: TourneyMatch, t: Translate): string {
  if (entry.bracket === "grandFinal") {
    return t(event.bracketKind === "swiss" ? "tournaments.recent.final" : "tournaments.recent.grandFinal");
  }
  if (entry.bracket === "thirdPlace") return t("tournaments.recent.thirdPlace");
  if (entry.bracket === "swiss") return t("tournaments.recent.round", { round: entry.round });
  if (entry.bracket === "freeForAll") {
    const lastRound = Math.max(...event.matches.map((held) => held.round));
    const inRound = event.matches.filter(
      (held) => held.bracket === "freeForAll" && held.round === entry.round,
    ).length;
    return inRound === 1 && entry.round === lastRound && entry.round > 1
      ? t("tournaments.recent.final")
      : t("tournaments.recent.round", { round: entry.round });
  }
  if (entry.bracket === "losers") return t("tournaments.recent.losersRound", { round: entry.round });

  // The winners bracket, named from its depth. The service's own round count
  // is the deepest winners round it drew.
  const rounds = Math.max(
    1,
    ...event.matches.filter((held) => held.bracket === "winners").map((held) => held.round),
  );
  const name =
    entry.round === rounds
      ? t("tournaments.recent.final")
      : entry.round === rounds - 1
        ? t("tournaments.recent.semis")
        : entry.round === rounds - 2
          ? t("tournaments.recent.quarters")
          : t("tournaments.recent.round", { round: entry.round });
  return event.bracketKind === "double" ? t("tournaments.recent.winners", { label: name }) : name;
}

/**
 * The maps a round is played on, by name: the round's own list, or for a 3rd
 * place match that has none, the semi-finals' maps. The website's `mapsFor`.
 * A map that is not in the database is named by its id, as the website does.
 */
export function roundMapNames(event: Tourney, entry: TourneyMatch): string[] {
  const listed = (key: string) => event.roundMaps.find((held) => held.round === key)?.mapIds ?? [];
  let ids = listed(roundKeyOf(entry.bracket, entry.round));
  if (entry.bracket === "thirdPlace" && ids.length === 0) {
    ids = listed(roundKeyOf("winners", entry.round - 1));
  }
  return ids.map((mapId) => event.mapDb.find((map) => map.id === mapId)?.name ?? mapId);
}

/** One placement of the rewards: where you finish, the money, and the rest. */
export interface RewardPlace {
  /** The placement: 1 for first, or the size of a "Top 4" group. */
  place: number;
  /** A "Top N" group rather than one placement. */
  top: boolean;
  /** The cash as the organiser wrote it ("$250"), or empty. */
  cash: string;
  /** Everything else this placement wins: an avatar, a qualification. */
  rest: string;
}

export interface RewardSplit {
  places: RewardPlace[];
  /** The lines that are not a placement, as the organiser wrote them. */
  notes: string;
}

// "1st", "2nd place", "3.": a bare number is not a placement ("8 players").
const ORDINAL = /^(\d{1,2})(?:st|nd|rd|th|\.|(?=\s+place\b))(?:\s+place)?\s*[:\-\u2013\u2014)]?\s*(.+)$/i;
const TOP = /^top\s*(\d{1,2})\s*[:\-\u2013\u2014]?\s*(.+)$/i;
const NAMED: [RegExp, number][] = [
  [/^(?:winner|champion|first)\s*[:\-\u2013\u2014]\s*(.+)$/i, 1],
  [/^(?:runner[\s-]?up|second)\s*[:\-\u2013\u2014]\s*(.+)$/i, 2],
  [/^third\s*[:\-\u2013\u2014]\s*(.+)$/i, 3],
];
const CASH = /(?:[$\u20ac\u20bd]\s?\d[\d,.]*|\d[\d,.]*\s?(?:[$\u20ac\u20bd]|usd|eur|rub)\b)/i;

/** A line with its markdown emphasis, list marker and heading mark taken off. */
function plainLine(line: string): string {
  return line
    .replace(/\*\*|__/g, "")
    .replace(/^\s*(?:#{1,6}\s+|[-*\u2022]\s+)/, "")
    .trim();
}

function placeOf(line: string): RewardPlace | null {
  const plain = plainLine(line);
  let place: number | null = null;
  let top = false;
  let body = "";
  const ordinal = ORDINAL.exec(plain);
  const grouped = TOP.exec(plain);
  if (grouped !== null) {
    place = Number(grouped[1]);
    top = true;
    body = grouped[2];
  } else if (ordinal !== null) {
    place = Number(ordinal[1]);
    body = ordinal[2];
  } else {
    for (const [pattern, at] of NAMED) {
      const named = pattern.exec(plain);
      if (named !== null) {
        place = at;
        body = named[1];
        break;
      }
    }
  }
  if (place === null || place < 1) return null;
  const cash = CASH.exec(body)?.[0].trim() ?? "";
  const rest = (cash === "" ? body : body.replace(cash, ""))
    .replace(/^[\s+,&\-\u2013\u2014]+|[\s+,&\-\u2013\u2014]+$/g, "")
    .replace(/\s*\+\s*\+\s*/g, " + ")
    .trim();
  return { place, top, cash, rest };
}

/**
 * The rewards split into placements, out of the organiser's own text.
 *
 * The service keeps the prize as one total and the rewards as free text, so
 * the split exists only in prose: "1st: $250 + avatar", "2nd - Faction face +
 * $80", "Top 4 qualify". Read line by line, each placement becomes a row and
 * everything else stays text. A heading over the list ("## Prizes") says what
 * the panel's own title already does and is dropped. "The winner takes it
 * all" with a total set is a split too, the whole prize to first.
 */
export function rewardSplit(text: string, totalCash: string): RewardSplit {
  const places: RewardPlace[] = [];
  const notes: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const place = placeOf(line);
    if (place !== null) {
      places.push(place);
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line) && plainLine(line).split(/\s+/).length <= 2) continue;
    notes.push(line);
  }
  if (places.length === 0 && totalCash !== "" && /winner takes (?:it )?all/i.test(text)) {
    places.push({ place: 1, top: false, cash: totalCash, rest: "" });
  }
  return { places, notes: notes.join("\n").trim() };
}
