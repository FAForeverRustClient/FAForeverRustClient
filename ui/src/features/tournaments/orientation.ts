// Where an event is, at a glance: the status pill, the stage stepper, the days
// it runs on, the list row's facts, and the one thing waiting on the reader.
//
// Each is the website's own rule, from `app.js` and `app.home.js`, kept here as
// pure functions so the header, the list and the overview draw the same answer
// and a test can read it without rendering anything.

import type { MessageKey } from "../../i18n";
import type { Tourney, TourneyStatus } from "../../ipc/bindings";
import { STATUS_LABELS } from "./tourneyPresentation";
import { mayPick, pendingSignups } from "../../shared/rules/tourneyRules";
import { myFactionGamesOwed, myMapVetoTurn } from "./bracket/vetoPresentation";
import { teamNameOf } from "./bracket/matchParts";
import { swissShowsBracket } from "./bracket/swissPresentation";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/**
 * Whether the event says `signup` while signups have not opened yet. The status
 * is `signup` from the moment an event is created, including while it waits for
 * a scheduled opening, so the pill would claim "Signups open" over an entry the
 * service would refuse.
 */
export function signupsNotOpenYet(event: Tourney, now: number): boolean {
  return (
    event.status === "signup" &&
    !event.abandoned &&
    event.signupOpensAt !== null &&
    event.signupOpensAt > now
  );
}

export interface StatusPill {
  label: MessageKey;
  /** A class suffix: the status, or `abandoned` / `presignup`. */
  tone: TourneyStatus | "abandoned" | "presignup";
}

/** The website's `statusPillLabel` and `statusPillClass`. */
export function statusPill(event: Tourney, now: number): StatusPill {
  if (event.abandoned) return { label: "tournaments.list.abandoned", tone: "abandoned" };
  if (signupsNotOpenYet(event, now)) {
    return { label: "tournaments.status.notOpenYet", tone: "presignup" };
  }
  return { label: STATUS_LABELS[event.status], tone: event.status };
}

export interface Stage {
  label: MessageKey;
  state: "done" | "now" | "next";
}

/**
 * The four stages an event moves through, and where it is. A draft event's
 * middle stage is its draft, everything else forms teams; Swiss and
 * free-for-all events play rounds rather than a bracket.
 */
export function stages(event: Tourney): Stage[] {
  const at: Record<TourneyStatus, number> = {
    signup: 0,
    draft: 1,
    drafted: 1,
    running: 2,
    finished: 3,
    unknown: 0,
  };
  const now = at[event.status];
  const middle: MessageKey =
    event.competition !== "freeForAll" && event.formation === "draft"
      ? "tournaments.stage.draft"
      : "tournaments.stage.teams";
  // A Swiss is its rounds until its playoffs exist; then, like the tab, the
  // step is the bracket.
  const play: MessageKey =
    event.competition === "freeForAll" || (event.bracketKind === "swiss" && !swissShowsBracket(event))
      ? "tournaments.section.rounds"
      : "tournaments.section.bracket";
  const labels: MessageKey[] = ["tournaments.stage.signups", middle, play, "tournaments.stage.results"];
  return labels.map((label, index) => ({
    label,
    state: index < now ? "done" : index === now ? "now" : "next",
  }));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function nextDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  const moment = new Date(Date.UTC(year, month - 1, date + 1));
  return moment.toISOString().slice(0, 10);
}

/** The days of a multi-day event, earliest first; none for a single day. */
function eventDayList(days: string[]): string[] {
  return days.length > 1 ? [...days].sort() : [];
}

/**
 * A multi-day event's days as runs: `12–13 Sep 2026`, `12–13 & 19–20 Sep 2026`,
 * `31 Dec 2026–1 Jan 2027`. Empty for a single day. The website's
 * `eventDaysLabel`: each endpoint carries only as much month and year as the
 * next one needs, which keeps "30 Sep–1 Oct 2026" from reading "30 Sep–1 Oct
 * Oct 2026".
 */
export function eventDaysLabel(days: string[]): string {
  const sorted = eventDayList(days);
  if (sorted.length === 0) return "";
  const runs: string[][] = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last !== undefined && nextDay(last[last.length - 1]) === day) last.push(day);
    else runs.push([day]);
  }
  const ends: string[] = [];
  for (const run of runs) {
    ends.push(run[0]);
    if (run.length > 1) ends.push(run[run.length - 1]);
  }
  const format = (day: string, index: number) => {
    const [year, month, date] = day.split("-");
    const next = ends[index + 1];
    const isLast = index === ends.length - 1;
    const needYear = isLast || (next !== undefined && next.slice(0, 4) !== year);
    const needMonth = isLast || needYear || (next !== undefined && next.slice(5, 7) !== month);
    return `${Number(date)}${needMonth ? ` ${MONTHS[Number(month) - 1]}` : ""}${needYear ? ` ${year}` : ""}`;
  };
  let index = 0;
  return runs
    .map((run) => {
      if (run.length === 1) return format(run[0], index++);
      const first = format(run[0], index++);
      const last = format(run[run.length - 1], index++);
      return `${first}–${last}`;
    })
    .join(" & ");
}

/** How many days a multi-day event runs on; 0 for a single day. */
export function eventDayCount(days: string[]): number {
  return eventDayList(days).length;
}

/** The list row's short format: `2v2 SE`, `1v1 Swiss`, `FFA`. */
export function listKind(event: Tourney): string {
  if (event.competition === "freeForAll") return "FFA";
  const bracket = { single: "SE", double: "DE", swiss: "Swiss" }[event.bracketKind];
  return `${event.teamSize}v${event.teamSize} ${bracket}`;
}

/** The rating limits in one line, or empty where there are none. */
export function listRatingLine(event: Tourney, t: Translate): string {
  const { min, max, maxTeam } = event.rating;
  const parts: string[] = [];
  if (min !== null && max !== null) parts.push(t("tournaments.list.ratingRange", { min, max }));
  else if (min !== null) parts.push(t("tournaments.list.ratingMin", { min }));
  else if (max !== null) parts.push(t("tournaments.list.ratingMax", { max }));
  if (maxTeam !== null) parts.push(t("tournaments.list.teamCap", { cap: maxTeam }));
  return parts.join(" · ");
}

/**
 * The entrant limits in one line, or empty. Players for a solo field or a
 * free-for-all, teams otherwise. The list endpoint sends no maximum, only the
 * minimum, so on a list row this is the minimum alone, as on the website.
 */
export function listTeamsLine(event: Tourney, t: Translate): string {
  const players = event.competition === "freeForAll" || event.teamSize === 1;
  const { minTeams: min, maxTeams: max } = event;
  if (min > 0 && max > 0) {
    return t(players ? "tournaments.list.playersRange" : "tournaments.list.teamsRange", { min, max });
  }
  if (min > 0) return t(players ? "tournaments.list.playersMin" : "tournaments.list.teamsMin", { count: min });
  if (max > 0) return t(players ? "tournaments.list.playersMax" : "tournaments.list.teamsMax", { count: max });
  return "";
}

export interface ListCountdowns {
  /** Seconds until signups open, while they have not. */
  signupsOpen: number | null;
  /** Seconds until the event starts, while it has not and signups are open. */
  eventStarts: number | null;
  /** Seconds until signups close, once they are open and a close is set. */
  signupsClose: number | null;
}

/** The instants a list row counts down to, in the website's precedence. */
export function listCountdowns(event: Tourney, now: number): ListCountdowns {
  const ahead = (moment: number | null) => (moment !== null && moment > now ? moment : null);
  const live = !event.abandoned;
  const signupsOpen = live && event.status === "signup" ? ahead(event.signupOpensAt) : null;
  const eventStarts =
    live && ["signup", "draft", "drafted"].includes(event.status) ? ahead(event.eventDate) : null;
  const signupsClose =
    live && event.status === "signup" && signupsOpen === null ? ahead(event.signupClosesAt) : null;
  return { signupsOpen, eventStarts, signupsClose };
}

/** The finished events grouped by the year they were played, newest first. */
export function archiveByYear(events: Tourney[]): { year: number | null; events: Tourney[] }[] {
  const byYear = new Map<number | null, Tourney[]>();
  for (const event of events) {
    const year = event.eventDate === null ? null : new Date(event.eventDate * 1000).getUTCFullYear();
    const held = byYear.get(year);
    if (held === undefined) byYear.set(year, [event]);
    else held.push(event);
  }
  return [...byYear.keys()]
    .sort((left, right) => (right ?? -1) - (left ?? -1))
    .map((year) => ({ year, events: byYear.get(year) ?? [] }));
}

export type TurnSection = "bracket" | "players" | "teams" | "draft" | "chat" | "vetoes";

export interface TurnInfo {
  text: string;
  cta: MessageKey;
  section: TurnSection;
}

/**
 * The one thing waiting on this account here, if anything: the website's
 * `myTurnInfo`, in its order of precedence. Shown above every section, because
 * the section it points at is usually not the one open.
 *
 * Choosing an opponent in a playoff pick phase is the website's second item and
 * is not here yet: the client does not run the pick phase.
 */
export function turnInfo(event: Tourney, t: Translate): TurnInfo | null {
  const viewer = event.viewer;
  const mine = viewer.memberTeamId;
  const opponentName = (teamIds: [string | null, string | null]) =>
    teamNameOf(event, teamIds[0] === mine ? teamIds[1] : teamIds[0]) ?? "";

  if (mine !== null) {
    const waiting = event.matches.find((entry) => {
      const report = entry.pendingReport;
      if (report === null || report.byTeam === mine) return false;
      const other = report.byTeam === entry.team1 ? entry.team2 : entry.team1;
      return other === mine;
    });
    if (waiting !== undefined && waiting.pendingReport !== null) {
      return {
        text: t("tournaments.turn.confirmScore", {
          score: `${waiting.pendingReport.score1}–${waiting.pendingReport.score2}`,
        }),
        cta: "tournaments.turn.reviewScore",
        section: "bracket",
      };
    }
  }

  if (viewer.organiser && event.status === "signup") {
    const requests = pendingSignups(event).length;
    if (requests > 0) {
      return {
        text: t("tournaments.turn.signupRequests", { count: requests }),
        cta: "tournaments.turn.reviewRequests",
        section: "players",
      };
    }
  }

  const captainOf = event.teams.find(
    (team) => team.id === mine && viewer.signedUpPlayerId !== null && team.captainId === viewer.signedUpPlayerId,
  );
  if (captainOf !== undefined && event.status === "signup" && captainOf.joinRequests.length > 0) {
    return {
      text: t("tournaments.turn.joinRequests", { count: captainOf.joinRequests.length }),
      cta: "tournaments.turn.reviewRequests",
      section: "teams",
    };
  }

  // An opponent pick outranks almost everything: the whole bracket waits on it.
  const picks = event.picks;
  if (picks !== null && picks.open && picks.turn !== null) {
    if (picks.myTurn) {
      const minutes = picks.secondsLeft === null ? null : Math.max(1, Math.round(picks.secondsLeft / 60));
      return {
        text:
          minutes === null
            ? t("tournaments.turn.pickOpponent")
            : `${t("tournaments.turn.pickOpponent")} ${t("tournaments.turn.pickMinutesLeft", { count: minutes })}`,
        cta: "tournaments.turn.pickOpponentCta",
        section: "bracket",
      };
    }
    if (viewer.organiser) {
      return {
        text: t("tournaments.turn.waitingOnPick", { team: teamNameOf(event, picks.turn) ?? "" }),
        cta: "tournaments.turn.viewPicks",
        section: "bracket",
      };
    }
  }

  if (event.status === "draft" && event.draft !== null && mayPick(event) && !viewer.organiser) {
    return { text: t("tournaments.turn.draftPick"), cta: "tournaments.turn.goToDraft", section: "draft" };
  }

  if (event.myMentionCount > 0) {
    return {
      text: t("tournaments.turn.mentioned", { count: event.myMentionCount }),
      cta: "tournaments.turn.openChat",
      section: "chat",
    };
  }

  if (viewer.organiser && event.chatPingCount > 0) {
    return {
      text: t("tournaments.turn.pinged", { count: event.chatPingCount }),
      cta: "tournaments.turn.openChat",
      section: "chat",
    };
  }

  if (viewer.organiser && event.veto.enabled && event.veto.teamA === "manual") {
    const unset = event.matches.filter(
      (entry) =>
        entry.veto !== null &&
        !entry.veto.done &&
        entry.status !== "done" &&
        (entry.veto.teamA === null || entry.veto.teamB === null),
    ).length;
    if (unset > 0) {
      return {
        text: t("tournaments.turn.setSides", { count: unset }),
        cta: "tournaments.turn.setThemNow",
        section: "vetoes",
      };
    }
  }

  if (mine !== null) {
    const mapTurn = event.matches.find((entry) => myMapVetoTurn(event, entry));
    if (mapTurn !== undefined && mapTurn.veto !== null) {
      const step = mapTurn.veto.sequence[mapTurn.veto.stepIndex];
      return {
        text: t(step?.action === "ban" ? "tournaments.turn.mapBan" : "tournaments.turn.mapPick", {
          team: opponentName([mapTurn.team1, mapTurn.team2]),
        }),
        cta: "tournaments.turn.goToVeto",
        section: "vetoes",
      };
    }

    const owed = event.matches.filter((entry) => myFactionGamesOwed(event, entry) > 0);
    if (owed.length > 0) {
      const games = owed.reduce((total, entry) => total + myFactionGamesOwed(event, entry), 0);
      const first = owed[0];
      const opponent = opponentName([first.team1, first.team2]);
      // The website names the step: a ban or a pick, as the service sends it.
      const step = first.factionVeto?.games.find((game) => game.next !== null)?.next ?? null;
      return {
        text:
          games === 1
            ? t(step?.action === "ban" ? "tournaments.turn.factionBan" : "tournaments.turn.factionPick", {
                team: opponent,
              })
            : owed.length === 1
              ? t("tournaments.turn.factionGamesVs", { count: games, team: opponent })
              : t("tournaments.turn.factionGames", { count: games }),
        cta: "tournaments.turn.goToFactionVeto",
        section: "vetoes",
      };
    }
  }

  return null;
}
