// How a tournament's typed facts read on screen.
//
// Pure functions rather than fields on the state: every one of these is derived
// from something the state already carries, and adding a rendered string per
// tournament would grow the payload to say what the client can work out.
//
// Presentation only. The rules the panes *gate* on are twins of
// `faf_domain::state::tourney` and live in `shared/tourneyRules.ts`, where the
// conformance harness can pin them: `store/` may not import from `features/`,
// so a twin left here would be a twin nothing can hold.

import type { MessageKey } from "../../i18n";
import type {
  BracketSide,
  InviteStatus,
  Tourney,
  TourneyMatch,
  TourneyStatus,
} from "../../ipc/bindings";

export const STATUS_LABELS: Record<TourneyStatus, MessageKey> = {
  draft: "tournaments.status.draft",
  signup: "tournaments.status.signup",
  drafted: "tournaments.status.drafted",
  running: "tournaments.status.running",
  finished: "tournaments.status.finished",
  unknown: "tournaments.status.unknown",
};

/**
 * How an outstanding invitation reads.
 *
 * A record rather than a key built from `invite.status`: a template literal has
 * to be asserted past the `MessageKey` union, and that assertion is what would
 * hide a missing translation until an organiser saw the raw key on screen.
 */
export const INVITE_STATUS_LABELS: Record<InviteStatus, MessageKey> = {
  pending: "tournaments.admin.invite.pending",
  accepted: "tournaments.admin.invite.accepted",
  declined: "tournaments.admin.invite.declined",
};

export const BRACKET_LABELS: Record<BracketSide, MessageKey> = {
  winners: "tournaments.bracket.winners",
  losers: "tournaments.bracket.losers",
  grandFinal: "tournaments.bracket.grandFinal",
  swiss: "tournaments.bracket.swiss",
  freeForAll: "tournaments.bracket.freeForAll",
};

/** A Unix-seconds timestamp as a readable local date and time, or a fallback. */
export function formatMoment(seconds: number | null, fallback: string): string {
  if (seconds === null) return fallback;
  return new Date(seconds * 1000).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Just the day, for a signup deadline where the hour is noise. */
export function formatDay(seconds: number | null, fallback: string): string {
  if (seconds === null) return fallback;
  return new Date(seconds * 1000).toLocaleDateString("en-US", { dateStyle: "medium" });
}

/**
 * The team size as players call it: `1v1`, `2v2`, or `FFA`.
 *
 * A free-for-all has no two sides, so a `6v6` there would be a lie about the
 * format rather than a shorthand for it.
 */
export function formatOf(event: Tourney): string {
  if (event.competition === "freeForAll") return "FFA";
  return `${event.teamSize}v${event.teamSize}`;
}

/**
 * The team the signed-in account plays for, if it has one.
 *
 * Read from the viewer block the server sends rather than matched on FAF id:
 * the server authorises every write against that same answer.
 */
export function myTeamId(event: Tourney): string | null {
  return event.viewer.memberTeamId;
}

/** Whether this account is one of the two sides of a match. */
export function isMyMatch(event: Tourney, entry: TourneyMatch): boolean {
  const mine = myTeamId(event);
  if (mine === null) return false;
  return entry.team1 === mine || entry.team2 === mine;
}

/**
 * The rating gate as one line, or empty when the organiser set none.
 *
 * Worth showing before entering rather than after: the server refuses a signup
 * below the minimum, and finding that out by being refused is a bad way to
 * learn the tournament was never for you.
 */
export function ratingGateOf(
  event: Tourney,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  const { min, max } = event.rating;
  if (min !== null && max !== null) return t("tournaments.overview.ratingBetween", { min, max });
  if (min !== null) return t("tournaments.overview.ratingFrom", { min });
  if (max !== null) return t("tournaments.overview.ratingUpTo", { max });
  return "";
}
