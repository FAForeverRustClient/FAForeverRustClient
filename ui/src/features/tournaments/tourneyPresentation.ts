// How a tournament's typed facts read on screen, and the rules the panes gate
// on.
//
// Pure functions rather than fields on the state: every one of these is derived
// from something the state already carries, and adding a rendered string per
// tournament would grow the payload to say what the client can work out.
//
// The rules at the bottom are hand-written twins of methods on
// `faf_domain::state::tourney`. They live here rather than in the component that
// happens to need them first, for one concrete reason: the conformance harness
// (`store/reducer.conformance.test.ts`) pins each one against what the Rust
// actually returns, and it cannot import a `.tsx` module without dragging React
// into the fixture replay. A rule that is only reachable through a component is
// a rule nothing can pin, and an unpinned twin drifts silently: exactly the
// failure the harness was built for.

import type { MessageKey } from "../../i18n";
import type {
  BracketSide,
  ChatRoom,
  InviteStatus,
  PlayerSummary,
  Tourney,
  TourneyAction,
  TourneyDraft,
  TourneyInvite,
  TourneyMap,
  TourneyMatch,
  TourneyPhase,
  TourneyPlayer,
  TourneyStatus,
  TourneyTeam,
  VaultMap,
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

// ---------------------------------------------------------------------------
// Twins of `faf_domain::state::tourney`. Each is pinned by the conformance
// fixture; if one drifts, `reducer.conformance.test.ts` fails rather than the
// pane quietly offering a control the server refuses.
// ---------------------------------------------------------------------------

/**
 * Why the server would refuse a draft.
 *
 * Spelled out rather than imported: `DraftRejection` never reaches `AppState`,
 * so specta does not put it in the generated bindings.
 */
export type DraftRejection =
  | "nameRequired"
  | "teamSizeOutOfRange"
  | "ratingRangeInverted"
  | "ratingGateWithoutRating"
  | "signupWindowInverted";

/**
 * Twin of `TourneyDraft::rejection`: the reasons the server would refuse.
 *
 * What stops an organiser filling in a long form only to be told the name was
 * missing. The order matters as much as the rules: the first refusal is the one
 * shown, so it must be the same first one the server would give.
 */
export function rejectionOf(draft: TourneyDraft): DraftRejection | null {
  if (draft.name.trim() === "") return "nameRequired";
  if (draft.teamSize < 1 || draft.teamSize > 6) return "teamSizeOutOfRange";
  const { min, max } = draft.rating;
  if (min !== null && max !== null && min > max) return "ratingRangeInverted";
  // A gate needs a rating to compare against, and an unrated event never
  // fetches one, so the two together can only refuse every signup.
  if (draft.ratingKind === "none" && (min !== null || max !== null)) {
    return "ratingGateWithoutRating";
  }
  const { signupOpensAt, signupClosesAt } = draft;
  if (signupOpensAt !== null && signupClosesAt !== null && signupOpensAt >= signupClosesAt) {
    return "signupWindowInverted";
  }
  return null;
}

/**
 * Twin of `MatchReport::new_games`: how many games a report adds to what is
 * already confirmed.
 *
 * A grand final with a handicap starts the upper-bracket side at 1-0, so an
 * absent score is not always zero.
 */
export function newGames(entry: TourneyMatch, score1: number, score2: number): number {
  const confirmed = (entry.score1 ?? (entry.handicap > 0 ? 1 : 0)) + (entry.score2 ?? 0);
  return Math.max(0, score1 + score2 - confirmed);
}

/**
 * Twin of `MatchReport::is_submittable`: what `report` will accept.
 *
 * No replay-id rule and no "the score must go up" rule. Both belonged to the
 * player path, which this client does not use: only the organiser records a
 * result, and `report` is also the correction path, so a lower score is a fix
 * rather than an error.
 */
export function isSubmittable(
  entry: TourneyMatch,
  score1: number,
  score2: number,
  winner: string | null = null,
): boolean {
  const needed = Math.ceil(entry.bestOf / 2);
  const scoresFit =
    score1 >= 0 &&
    score2 >= 0 &&
    score1 <= needed &&
    score2 <= needed &&
    !(score1 === needed && score2 === needed) &&
    !(entry.handicap > 0 && score1 < 1);
  // A named winner has to be one of the two sides, or the server refuses it.
  const winnerFits = winner === null || winner === entry.team1 || winner === entry.team2;
  return scoresFit && winnerFits;
}

/** Twin of `faf_domain::state::map_key`: letters and digits, folded. */
export function mapKey(name: string): string {
  return [...name].filter((character) => /\p{L}|\p{N}/u.test(character)).join("").toLowerCase();
}

/** Strip a version suffix like `.v0001` before comparing folder names. */
function withoutVersion(folder: string): string {
  return folder.split(".v")[0];
}

/**
 * The vault map a tournament map refers to, or null when it was never uploaded.
 *
 * Twin of `match_vault_map`: the display name first, the folder name second, so
 * both `Seton's Clutch` and `scmp_009` resolve to the same entry. Preferred over
 * the tournament server's own image, which is usually absent: the vault preview
 * is the picture players already recognise from the maps tab.
 */
export function matchVaultMap(tourneyMap: TourneyMap, vault: VaultMap[]): VaultMap | null {
  const wanted = mapKey(tourneyMap.name);
  if (wanted === "") return null;
  const byName = vault.find((candidate) => mapKey(candidate.displayName) === wanted);
  if (byName !== undefined) return byName;
  // The version has to come off both sides: an organiser who copied
  // `scmp_009.v0001` out of their maps directory means the vault's v0002 too.
  const wantedFolder = mapKey(withoutVersion(tourneyMap.name.trim()));
  return (
    vault.find((candidate) => mapKey(withoutVersion(candidate.folderName)) === wantedFolder) ?? null
  );
}

/** Twin of `Tourney::team_rating`: what `maxTeamRating` is measured against. */
export function teamRating(event: Tourney, team: TourneyTeam): number {
  return team.playerIds
    .map((id) => event.players.find((player) => player.id === id)?.rating ?? 0)
    .reduce((total, rating) => total + rating, 0);
}

/**
 * Twin of `Tourney::would_exceed_team_cap`.
 *
 * Checked before offering the request: the server's refusal names the number
 * the team would reach, which is a humiliating way to find out.
 */
export function wouldExceedCap(event: Tourney, team: TourneyTeam): boolean {
  const cap = event.rating.maxTeam;
  if (cap === null) return false;
  const mine =
    event.players.find((player) => player.id === event.viewer.signedUpPlayerId)?.rating ?? null;
  if (mine === null) return false;
  return teamRating(event, team) + mine > cap;
}

/** Twin of `Tourney::teams_are_self_organised`. */
export function selfOrganised(event: Tourney): boolean {
  return event.formation === "open" && event.teamSize > 1 && event.status === "signup";
}

/** Twin of `Tourney::may_reseed`: only between forming teams and the draw. */
export function mayReseed(event: Tourney): boolean {
  return event.status === "drafted" && event.teams.length > 0;
}

/**
 * Twin of `Tourney::pending_signups`: entries waiting on the organiser.
 *
 * The server shows a pending entry only to organisers and to the person who
 * asked, so this is already the right list for whoever is looking.
 */
export function pendingSignups(event: Tourney): TourneyPlayer[] {
  return event.players.filter((player) => player.pending);
}

/**
 * Twin of `TourneyState::profile_of`: the FAF account behind an entrant.
 *
 * Not every entrant has one, and that is a real case rather than a failure: an
 * organiser can add a player by hand and that entry is a name and nothing else.
 * The one place this lookup lives, because every list that shows an entrant
 * needs it — and a list that skipped it is what makes the same person appear
 * with an avatar in one section and as a bare string in another.
 */
export function profileOf(
  profiles: PlayerSummary[],
  entrant: Pick<TourneyPlayer, "fafId">,
): PlayerSummary | null {
  if (entrant.fafId === null) return null;
  return profiles.find((profile) => profile.id === entrant.fafId) ?? null;
}

/** The account behind an invitation, which names its FAF id outright. */
export function profileOfInvite(
  profiles: PlayerSummary[],
  invite: Pick<TourneyInvite, "fafId">,
): PlayerSummary | null {
  return profiles.find((profile) => profile.id === invite.fafId) ?? null;
}

/**
 * Twin of `Tourney::may_shuffle_teams`: whether the organiser may still move
 * people between teams.
 *
 * Refused once the bracket is drawn — the draw is made from the teams, so
 * changing them afterwards would leave the bracket describing an event that no
 * longer exists.
 */
export function mayShuffleTeams(event: Tourney): boolean {
  return event.viewer.organiser && !hasBracket(event.status) && event.teamSize > 1;
}

/**
 * Twin of `Tourney::may_set_rating`: whether a rating can be typed for an
 * entrant.
 *
 * Only an unrated event. Everywhere else the service fetched the rating as of
 * the event's rating date and refuses a typed one, so the field is withheld
 * rather than offered and refused.
 */
export function maySetRating(event: Tourney): boolean {
  return event.viewer.organiser && event.ratingKind === "none";
}

/** Twin of `TourneyStatus::has_bracket`. */
export function hasBracket(status: TourneyStatus): boolean {
  return status === "running" || status === "finished";
}

/**
 * Twin of `Tourney::may_rename`: who may rename or disband a team.
 *
 * An organiser may rename any team as often as needed. A captain gets exactly
 * one, and only where teams hold more than one player — the server counts it in
 * `captainRenamed` and refuses the second, so the control is withdrawn rather
 * than offered and then refused.
 */
export function mayRename(event: Tourney, team: TourneyTeam): boolean {
  if (event.viewer.organiser) return true;
  const mine = event.viewer.signedUpPlayerId;
  const captain = mine !== null && team.captainId === mine;
  return captain && event.teamSize > 1 && !team.captainRenamed;
}

/** Twin of `Tourney::members`: everyone on a team, in the order they joined. */
export function teamMembers(event: Tourney, team: TourneyTeam): TourneyPlayer[] {
  return team.playerIds
    .map((id) => event.players.find((player) => player.id === id))
    .filter((player): player is TourneyPlayer => player !== undefined);
}

/**
 * Twin of `Tourney::my_invites`: the teams that have invited this account.
 *
 * Surfaced rather than buried in the team list: an invite is the one thing in
 * that pane waiting on the reader rather than on somebody else.
 */
export function myInvites(event: Tourney): TourneyTeam[] {
  const mine = event.viewer.signedUpPlayerId;
  if (mine === null) return [];
  return event.teams.filter((team) => team.invites.some((invite) => invite.playerId === mine));
}

/**
 * Twin of `TourneyState::busy_match_id`: the one match a write is in flight
 * against, or null when the pending write is event-wide.
 *
 * One match's spinner must not disable the rest of the bracket.
 */
export function busyMatchId(pending: TourneyAction | null): string | null {
  if (pending === null) return null;
  switch (pending.type) {
    case "submittingReport":
    case "answeringReport":
    case "decidingReport":
      return pending.payload.matchId;
    default:
      return null;
  }
}

/** Twin of `TourneyPhase::is_legal_from`: which step the server will accept. */
export function isLegalFrom(phase: TourneyPhase, status: TourneyStatus): boolean {
  switch (phase) {
    case "formTeams":
      return status === "signup";
    case "startBracket":
      return status === "drafted";
    case "reopenSignups":
      return status === "signup" || status === "draft" || status === "drafted";
  }
}

/** Twin of `TourneyState::unread_total`: unread across every room of the open event. */
export function unreadTotal(rooms: ChatRoom[]): number {
  return rooms.reduce((total, room) => total + room.unread, 0);
}

/**
 * Twin of `TourneyState::open_event`: the detail, only if it is really the open
 * row's.
 *
 * Guards the window between selecting a row and its detail arriving, where the
 * previous event's bracket would otherwise be shown under the new event's name.
 */
export function openEvent(detail: Tourney | null, selectedId: string | null): Tourney | null {
  if (detail === null) return null;
  return detail.id === selectedId ? detail : null;
}
