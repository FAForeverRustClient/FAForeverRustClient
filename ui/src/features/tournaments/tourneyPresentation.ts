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
  BracketKind,
  BracketSide,
  Formation,
  InviteStatus,
  Prize,
  RatingKind,
  Tourney,
  TourneyMatch,
  TourneyPlayer,
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

/**
 * Entrants in the order the website ranks them: by the rating this tournament
 * seeds on, highest first, with the unrated at the bottom.
 *
 * Presentation, and deliberately not a twin: nothing in `faf_domain` orders
 * entrants, because nothing in the client *decides* anything from this order.
 * It is the row position that the `#` column shows and nothing else.
 *
 * The sort is stable, so entrants on the same rating stay in the order the
 * service listed them, which is the order they signed up in.
 */
export function rankedEntrants(players: TourneyPlayer[]): TourneyPlayer[] {
  return [...players].sort((left, right) => {
    if (left.rating === null && right.rating === null) return 0;
    // Unrated last, whichever way round the pair arrives.
    if (left.rating === null) return 1;
    if (right.rating === null) return -1;
    return right.rating - left.rating;
  });
}

/**
 * How a tournament's rows are grouped in the list.
 *
 * The same four the website uses, and for the same reason: an unfiltered list
 * of every tournament FAF has ever run is a scroll with the useful part at the
 * top and no way to tell where it ends. `past` holds the finished and the
 * abandoned, and it is the one that folds away.
 */
export type ListGroup = "drafts" | "upcoming" | "ongoing" | "past";

/** Which group a tournament belongs in. One group each, checked in order. */
export function groupOf(event: Tourney): ListGroup {
  if (!event.published) return "drafts";
  // Abandoned outranks the status: the event still says `signup` or `running`,
  // and it is neither. It is over, and it belongs with the things that are.
  if (event.abandoned || event.status === "finished") return "past";
  if (event.status === "signup") return "upcoming";
  return "ongoing";
}

/**
 * The list, split into its groups, each in the order that group is read in.
 *
 * Upcoming and ongoing keep the service's own order, which is newest-created
 * first. The past is sorted by when it happened rather than when it was made:
 * the interesting end of an archive is the recent end.
 */
export function groupedEvents(events: Tourney[]): Record<ListGroup, Tourney[]> {
  const groups: Record<ListGroup, Tourney[]> = {
    drafts: [],
    upcoming: [],
    ongoing: [],
    past: [],
  };
  for (const event of events) groups[groupOf(event)].push(event);
  groups.past.sort((left, right) => (right.eventDate ?? 0) - (left.eventDate ?? 0));
  return groups;
}

/**
 * How long until an instant, as `2 days, 3 h, 40 min`, or null once it passes.
 *
 * The website's own shape, down to dropping the hours when there is no day and
 * always keeping the minutes: a countdown that says "in 2 days" tells nobody
 * whether to wait for it.
 */
export function countdownTo(seconds: number | null, now: number): string | null {
  if (seconds === null) return null;
  const left = seconds - now;
  if (left <= 0) return null;
  const days = Math.floor(left / 86_400);
  const hours = Math.floor((left % 86_400) / 3_600);
  const minutes = Math.floor((left % 3_600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} d`);
  if (days > 0 || hours > 0) parts.push(`${hours} h`);
  parts.push(`${minutes} min`);
  return parts.join(", ");
}

/**
 * The headline cash prize, as the website writes it.
 *
 * Twin of its `formatPrize`, down to where the symbol sits: rubles put it
 * after the number, the other two before. Held in cents, so a round amount
 * prints without decimals and an odd one keeps both.
 */
export function formatPrize(prize: Prize | null): string {
  if (prize === null) return "";
  const units = prize.amountCents / 100;
  const number = units.toLocaleString("en-US", { maximumFractionDigits: 2 });
  const symbol = { usd: "$", eur: "\u20ac", rub: "\u20bd" }[prize.currency];
  return prize.currency === "rub" ? `${number} ${symbol}` : `${symbol}${number}`;
}

/**
 * What kind of event this is, in one line: the website's `typeLine`.
 *
 * An import says where it came from instead of describing a format, because
 * Challonge never told the service the team size and inventing one would put a
 * confident lie at the top of the page.
 */
export function typeLine(
  event: Tourney,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  if (event.imported) return t("tournaments.overview.imported");

  const cap =
    event.maxTeams > 0
      ? ` \u00b7 ${t("tournaments.overview.capMax", { count: event.maxTeams })}`
      : "";

  if (event.competition === "freeForAll" && event.ffa !== null) {
    const size =
      event.teamSize === 1
        ? t("tournaments.overview.ffaSolo")
        : t("tournaments.overview.ffaTeams", { size: event.teamSize });
    const mode = t(
      event.ffa.mode === "points"
        ? "tournaments.overview.ffaPoints"
        : "tournaments.overview.ffaKnockout",
    );
    return `${mode} \u00b7 ${size} \u00b7 ${t("tournaments.overview.ffaPerLobby", {
      count: event.ffa.perMatch,
    })}${cap}`;
  }

  const bracket = t(BRACKET_KIND_LABELS[event.bracketKind]);
  const shape =
    event.teamSize === 1
      ? "1v1"
      : `${event.teamSize}v${event.teamSize} \u00b7 ${t(FORMATION_LABELS[event.formation])}`;
  return `${shape} \u00b7 ${bracket}${cap}`;
}

export const BRACKET_KIND_LABELS: Record<BracketKind, MessageKey> = {
  single: "tournaments.overview.singleElim",
  double: "tournaments.overview.doubleElim",
  swiss: "tournaments.overview.swiss",
};

/** Which FAF rating an event seeds and gates on, as players name it. */
export const RATING_KIND_LABELS: Record<RatingKind, MessageKey> = {
  global: "tournaments.rating.global",
  ladder1v1: "tournaments.rating.ladder",
  team2v2: "tournaments.rating.team2v2",
  team3v3: "tournaments.rating.team3v3",
  team4v4: "tournaments.rating.team4v4",
  combined: "tournaments.rating.combined",
  none: "tournaments.rating.none",
};

export const FORMATION_LABELS: Record<Formation, MessageKey> = {
  solo: "tournaments.overview.formationSolo",
  open: "tournaments.overview.formationOpen",
  draft: "tournaments.overview.formationDraft",
};

/**
 * How long the matches are: the website's `planSummary`.
 *
 * Empty when the event has no plan, which is what a free-for-all and an import
 * both are. The per-round overrides the website can also show are not read
 * here, because the client cannot set them either.
 */
export function planSummary(
  event: Tourney,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string {
  if (event.competition === "freeForAll" && event.ffa !== null) {
    const ffa = event.ffa;
    if (ffa.mode === "points") {
      const parts = [t("tournaments.overview.ffaRounds", { count: ffa.rounds })];
      if (ffa.cutTo > 0) parts.push(t("tournaments.overview.ffaCut", { count: ffa.cutTo }));
      parts.push(
        ffa.finalSize > 0
          ? t("tournaments.overview.ffaFinal", { count: ffa.finalSize })
          : t("tournaments.overview.ffaHighest"),
      );
      return parts.join(" \u00b7 ");
    }
    return t("tournaments.overview.ffaAdvance", { count: ffa.advance });
  }

  const plan = event.plan;
  if (plan === null) return "";
  if (plan.type === "single") {
    return t("tournaments.overview.planSingle", {
      early: plan.payload.early,
      semi: plan.payload.semi,
      final: plan.payload.finalBo,
    });
  }
  if (plan.type === "double") {
    const line = t("tournaments.overview.planDouble", {
      wb: plan.payload.wb,
      wbFinal: plan.payload.wbFinal,
      lb: plan.payload.lb,
      lbFinal: plan.payload.lbFinal,
      gf: plan.payload.gf,
    });
    return plan.payload.lbHandicap
      ? `${line} \u00b7 ${t("tournaments.overview.planHandicap")}`
      : line;
  }
  const parts = [
    t("tournaments.overview.planSwiss", { bo: plan.payload.bestOf }),
    plan.payload.finalMatch
      ? t("tournaments.overview.planSwissFinal", { bo: plan.payload.finalBestOf })
      : t("tournaments.overview.planSwissNoFinal"),
  ];
  if (plan.payload.fast) parts.push(t("tournaments.overview.planSwissFast"));
  return parts.join(" \u00b7 ");
}

/**
 * The rating requirements, one line per rule.
 *
 * Longer than `ratingGateOf`, which is the same facts squeezed into a row of a
 * fact list. This is the overview's own cell, where the cap is worth spelling
 * out: an entrant refused for being too strong and one silently counted as
 * weaker are very different things to be told about beforehand.
 */
export function ratingRequirements(
  event: Tourney,
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
): string[] {
  const lines: string[] = [];
  const { min, max, maxTeam, cap } = event.rating;
  if (min !== null && max !== null) lines.push(t("tournaments.overview.ratingBetween", { min, max }));
  else if (min !== null) lines.push(t("tournaments.overview.ratingFrom", { min }));
  else if (max !== null) lines.push(t("tournaments.overview.ratingUpTo", { max }));
  if (maxTeam !== null) lines.push(t("tournaments.overview.ratingTeamCap", { max: maxTeam }));
  if (cap !== null) lines.push(t("tournaments.overview.ratingClamp", { cap }));
  return lines;
}
