// Hand-written twins of methods on `faf_domain::state::tourney`.
//
// Here rather than in the tournaments feature for one enforced reason: the
// conformance harness (`store/reducer.conformance.test.ts`) pins each of these
// against what the Rust actually returns, and `store/` may not import from
// `features/` (`scripts/check-architecture.mjs`). The other pinned twins,
// `galacticWarActions` and `playerNotes`, already live here for the same reason.
//
// A rule reachable only through a component is a rule nothing can pin, and an
// unpinned twin drifts silently: exactly the failure the harness was built for.
// `may_report` proved it, having lost the `has_bracket` half of its condition
// while it sat inside `BracketView.tsx`.

import type {
  BracketConfig,
  BracketKind,
  BracketSide,
  ChatRoom,
  Competition,
  FfaReport,
  MapDraft,
  MatchVeto,
  PoolAction,
  PoolSide,
  PoolDraft,
  PlayerSummary,
  FormatDraft,
  QualifierKind,
  QualifierRule,
  SeriesDraft,
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
} from "../ipc/bindings";

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
 * needs it, and a list that skipped it is what makes the same person appear
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
 * Refused once the bracket is drawn: the draw is made from the teams, so
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
 * Twin of `Tourney::may_report`: whether this account may record a result.
 *
 * The organiser and nobody else. `has_bracket` is part of it: the server refuses
 * `report` before the draw exists, and a control offered there reads as broken
 * rather than as not-yet. A finished match stays reportable, because `report` is
 * also the correction path and undoes the old result first.
 *
 * Free-for-all rounds are excluded because `report` takes a different body for
 * them, which this client does not send yet.
 */
export function mayReport(event: Tourney, entry: TourneyMatch): boolean {
  return (
    event.viewer.organiser &&
    hasBracket(event.status) &&
    entry.bracket !== "freeForAll" &&
    entry.team1 !== null &&
    entry.team2 !== null
  );
}

/**
 * One row of the standings table.
 *
 * Spelled out rather than imported, like `DraftRejection` above: `Standing` is
 * derived from `Tourney` and never reaches `AppState`, so specta does not put
 * it in the generated bindings. The shapes below are what the Rust serialises,
 * which the conformance fixture proves rather than asserts.
 */
export interface Standing {
  teamId: string;
  /** The place as shown, or null for a team whose run has not ended. */
  place: number | null;
  outcome: StandingOutcome;
  wins: number;
  losses: number;
  gameDiff: number;
}

/** Why a team sits where it does. */
export type StandingOutcome =
  | "champion"
  | "stillIn"
  | "lostFinal"
  | "placed"
  | "swiss"
  | { outIn: { bracket: BracketSide; round: number } };

/** Which table the standings are. */
export type StandingsKind = "none" | "swiss" | "elimination" | "imported" | "points";

/**
 * Whose veto step is due. Spelled out like `Standing` above: derived from the
 * run rather than part of it, so specta does not generate it.
 */
export interface VetoTurn {
  teamId: string;
  action: PoolAction;
  /** Which side of the order it is, which is what the service checks. */
  side: PoolSide;
}

/**
 * Twin of `MatchVeto::current_turn`: whose step is due, or null.
 *
 * Null covers three different things on purpose, because the panel treats them
 * the same: the run is finished, an organiser has not said which team is A, or
 * the order has been walked off the end.
 */
export function vetoTurn(veto: MatchVeto): VetoTurn | null {
  if (veto.done) return null;
  if (veto.teamA === null || veto.teamB === null) return null;
  const step = veto.sequence[veto.stepIndex];
  if (step === undefined) return null;
  return {
    teamId: step.team === "a" ? veto.teamA : veto.teamB,
    action: step.action,
    side: step.team,
  };
}

/**
 * Twin of `Tourney::may_veto`: whether this account may take the step that is
 * due.
 *
 * Captaincy, not membership: the service checks the captain, so a team-mate
 * offered the grid would click into a refusal. An organiser may act for either
 * side, which is how a run gets unstuck when a captain is absent.
 */
export function mayVeto(event: Tourney, entry: TourneyMatch): boolean {
  if (entry.veto === null || !event.veto.enabled || entry.status === "done") return false;
  const turn = vetoTurn(entry.veto);
  if (turn === null) return false;
  if (event.viewer.organiser) return true;
  const team = event.teams.find((held) => held.id === turn.teamId);
  const mine = event.viewer.signedUpPlayerId;
  return team !== undefined && mine !== null && team.captainId === mine;
}

/** Twin of `Tourney::may_set_veto_sides`: only before the first step. */
export function maySetVetoSides(event: Tourney, entry: TourneyMatch): boolean {
  if (!event.viewer.organiser || !event.veto.enabled || entry.veto === null) return false;
  return entry.veto.stepIndex === 0 && !entry.veto.done && entry.veto.teamA === null;
}

/** Twin of `Draft::turn`, wrapped: the team whose pick is due. */
export function draftTurn(event: Tourney): string | null {
  if (event.status !== "draft" || event.draft === null) return null;
  return event.draft.order[event.draft.current] ?? null;
}

/**
 * Twin of `Tourney::may_pick`: whether this account may make the pick.
 *
 * The captain of the team on the clock, or an organiser picking for them. Same
 * shape as `mayVeto` and for the same reason: the service checks captaincy, so
 * offering the list to a team-mate offers a refusal.
 */
export function mayPick(event: Tourney): boolean {
  const turn = draftTurn(event);
  if (turn === null) return false;
  if (event.viewer.organiser) return true;
  const team = event.teams.find((held) => held.id === turn);
  const mine = event.viewer.signedUpPlayerId;
  return team !== undefined && mine !== null && team.captainId === mine;
}

/**
 * Twin of `Tourney::may_undo_pick`.
 *
 * An organiser at any point. A captain only their own pick, and only while
 * nobody has picked after them: undoing later would rewrite somebody else's
 * turn.
 */
export function mayUndoPick(event: Tourney): boolean {
  if (event.status !== "draft" && event.status !== "drafted") return false;
  const last = event.draft?.lastPick;
  if (last === undefined || last === null || event.draft === null) return false;
  if (event.viewer.organiser) return true;
  const team = event.teams.find((held) => held.id === last.teamId);
  const mine = event.viewer.signedUpPlayerId;
  return (
    event.draft.current === last.atIndex + 1 &&
    team !== undefined &&
    mine !== null &&
    team.captainId === mine
  );
}

/**
 * Twin of `Tourney::undrafted`: entrants still waiting to be picked.
 *
 * A pending signup is not in the pool: the organiser has not accepted them, and
 * the service refuses a pick naming one.
 */
export function undrafted(event: Tourney): TourneyPlayer[] {
  return event.players.filter((player) => !player.pending && player.teamId === null);
}

/**
 * Twin of `Tourney::ffa_winners_needed`: how many winners this lobby wants.
 *
 * One in a final, otherwise the smaller of the configured `advance` and one
 * short of the field, because a lobby cannot advance everybody in it. A round
 * down to one lobby is the final whether or not it says so.
 */
export function ffaWinnersNeeded(event: Tourney, entry: TourneyMatch): number {
  if (event.ffa === null) return 0;
  const onlyLobby =
    event.matches.filter(
      (other) => other.bracket === "freeForAll" && other.round === entry.round,
    ).length === 1;
  if (entry.isFinal || onlyLobby) return 1;
  return Math.min(event.ffa.advance, Math.max(entry.entrants.length - 1, 0));
}

/**
 * Twin of `Tourney::ffa_is_scored`: whether this lobby is scored rather than
 * won. A points event still decides its final by a winner.
 */
export function ffaIsScored(event: Tourney, entry: TourneyMatch): boolean {
  return event.ffa?.mode === "points" && !entry.isFinal;
}

/** Twin of `Tourney::may_report_ffa`. */
export function mayReportFfa(event: Tourney, entry: TourneyMatch): boolean {
  return (
    event.viewer.organiser &&
    hasBracket(event.status) &&
    entry.bracket === "freeForAll" &&
    entry.entrants.length > 0
  );
}

/**
 * Twin of `FfaReport::is_submittable`: what the service will accept.
 *
 * A scored round wants a number from 0 to 1000 for every entrant; an
 * elimination round wants exactly the winners the format calls for, each of
 * them in the lobby and none of them named twice.
 */
export function ffaReportIsSubmittable(
  report: FfaReport,
  entry: TourneyMatch,
  scored: boolean,
  winnersNeeded: number,
): boolean {
  if (scored) {
    const covered = entry.entrants.every((id) =>
      report.points.some((scored) => scored.teamId === id),
    );
    return (
      covered &&
      entry.entrants.length > 0 &&
      report.points.every(
        (scored) => Number.isInteger(scored.points) && scored.points >= 0 && scored.points <= 1000,
      )
    );
  }
  const inside = report.winners.every((id) => entry.entrants.includes(id));
  const unique = new Set(report.winners).size === report.winners.length;
  return inside && unique && report.winners.length === winnersNeeded;
}

/** Why a pool cannot be saved. Spelled out for the same reason as above. */
export type PoolRejection =
  | "nameRequired"
  | "mapsRequired"
  | { stepCountWrong: { wanted: number; got: number } }
  | { pickCountWrong: { wanted: number; got: number } };

/**
 * Twin of `PoolDraft::rejection`: why the service would refuse this pool.
 *
 * Its two counting rules read as arithmetic but are a real constraint: every map
 * but one is consumed by a step, and every pick is a game, so a Bo3 wants four
 * maps and three steps of which two are picks. Checked before sending, because
 * the service's refusal names numbers the organiser then has to work backwards
 * from.
 */
export function poolRejection(draft: PoolDraft): PoolRejection | null {
  if (draft.name.trim() === "") return "nameRequired";
  if (draft.mapIds.length === 0) return "mapsRequired";
  // No order at all is legal: the pool is then a plain list of maps.
  if (draft.sequence.length === 0) return null;
  if (draft.sequence.length !== draft.mapIds.length - 1) {
    return { stepCountWrong: { wanted: draft.mapIds.length - 1, got: draft.sequence.length } };
  }
  const picks = draft.sequence.filter((step) => step.action === "pick").length;
  const wanted = (draft.bestOf ?? 1) - 1;
  if (picks !== wanted) return { pickCountWrong: { wanted, got: picks } };
  return null;
}

/**
 * Why the service would refuse a qualifier link.
 *
 * Spelled out rather than imported, like the other rejections: `QualifierRejection`
 * never reaches `AppState`, so specta does not generate it.
 */
export type QualifierRejection =
  | "sameEvent"
  | "alreadyLinked"
  | "cutoffTooLow"
  | "pointsWithoutScores";

/**
 * Twin of `QualifierKind::suits`: whether the child's format keeps a score to
 * rank by.
 *
 * A points rule needs one per entrant, which only Swiss and free-for-all have.
 */
export function ruleSuits(
  kind: QualifierKind,
  competition: Competition,
  bracket: BracketKind,
): boolean {
  if (kind === "top") return true;
  return competition === "freeForAll" || bracket === "swiss";
}

/**
 * Twin of `Tourney::qualifier_rejection`: why this link would be refused.
 *
 * Three of the four mirror a refusal the service makes. The fourth does not, and
 * is the reason this is worth having at all: a points rule against an
 * elimination bracket is *accepted* and then qualifies nobody, silently, so the
 * organiser learns about it when the invites never arrive.
 */
export function qualifierRejection(
  event: Tourney,
  candidate: Tourney,
  rule: QualifierRule,
): QualifierRejection | null {
  if (candidate.id === event.id) return "sameEvent";
  if (event.qualifiers.some((link) => link.tournamentId === candidate.id)) return "alreadyLinked";
  if (rule.n < 1) return "cutoffTooLow";
  if (!ruleSuits(rule.kind, candidate.competition, candidate.bracketKind)) {
    return "pointsWithoutScores";
  }
  return null;
}

/**
 * Twin of `Tourney::may_edit_format`: whether the format can still be changed.
 *
 * The service locks it once the bracket exists: the draw was made from the
 * format, so changing it afterwards would leave a bracket describing an event
 * that no longer exists.
 */
export function mayEditFormat(event: Tourney): boolean {
  return (
    event.viewer.organiser &&
    (event.status === "signup" || event.status === "draft" || event.status === "drafted")
  );
}

/**
 * Twin of `Tourney::may_edit_team_setup`: narrower again.
 *
 * The competition, the team size, the formation and the draft order decide what
 * a team *is*, so the service takes them only while signups are open.
 */
export function mayEditTeamSetup(event: Tourney): boolean {
  return event.viewer.organiser && event.status === "signup";
}

/**
 * Twin of `FormatDraft::is_structural`: whether this change touches the team
 * setup.
 *
 * Load-bearing rather than cosmetic: the service refuses those four keys
 * outside signups on *presence* alone, so an unchanged team size sent along
 * with a bracket-type change is refused for touching neither.
 */
export function isStructural(format: FormatDraft, event: Tourney): boolean {
  return (
    format.competition !== event.competition ||
    format.teamSize !== event.teamSize ||
    format.formation !== event.formation ||
    format.draftSnakes !== event.draftSnakes
  );
}

/**
 * Twin of `Tourney::may_post_chat`.
 *
 * Two separate reasons it might be false, kept apart because the composer has
 * to say which: the room locks two days after the event, and an organiser can
 * silence one account.
 */
export function mayPostChat(event: Tourney): boolean {
  return event.viewer.loggedIn && !event.chatLocked && !event.chatMutedMe;
}

/**
 * Twin of `Tourney::unread_news`: announcements posted since this account last
 * read them.
 *
 * Zero for a signed-out reader: the service remembers nothing for them, and a
 * badge that never cleared would be worse than none.
 */
export function unreadNews(event: Tourney): number {
  if (!event.viewer.loggedIn) return 0;
  const readAt = event.viewer.newsReadAt ?? 0;
  return event.news.filter((post) => (post.at ?? 0) > readAt).length;
}

/**
 * One round of the draw, as the key a map pool is bound by.
 *
 * Spelled out rather than imported, like `Standing` above: it is derived from
 * `Tourney` and never reaches `AppState`, so specta does not generate it.
 */
export interface RoundKey {
  /** The service's own grammar, `{bracket}:{round}`. */
  key: string;
  bracket: BracketSide;
  round: number;
  /** The deepest round this bracket has, so a label can name a final. */
  lastRound: number;
}

/** Which rounds an event will have, and whether that is known or expected. */
export interface RoundPlan {
  keys: RoundKey[];
  /** True while these are projected from the expected entrant count. */
  projected: boolean;
  /** The team count the projection was made from. Zero once real. */
  teams: number;
}

/**
 * Twin of `Tourney::projected_team_count`.
 *
 * The teams once formed; otherwise the entrant cap, if one was set; otherwise
 * the signups divided by the team size. The cap is in the middle for a reason:
 * an organiser who set one has answered before anybody entered.
 */
export function projectedTeamCount(event: Tourney): number {
  if (event.teams.length > 0) return event.teams.length;
  if (event.maxTeams > 0) return event.maxTeams;
  const size = event.competition === "freeForAll" ? 1 : Math.max(event.teamSize, 1);
  return Math.floor(event.players.length / size);
}

/** Rounds a single-elimination bracket of this size takes: `ceil(log2(n))`. */
export function roundsFor(teams: number): number {
  let size = 1;
  let rounds = 0;
  while (size < teams) {
    size *= 2;
    rounds += 1;
  }
  return rounds;
}

const BRACKET_WIRE: Record<BracketSide, string> = {
  winners: "wb",
  losers: "lb",
  grandFinal: "gf",
  swiss: "sw",
  freeForAll: "ffa",
};

function roundKeys(pairs: [BracketSide, number][]): RoundKey[] {
  return pairs.map(([bracket, round]) => ({
    key: `${BRACKET_WIRE[bracket]}:${round}`,
    bracket,
    round,
    lastRound: Math.max(
      ...pairs.filter(([side]) => side === bracket).map(([, deepest]) => deepest),
    ),
  }));
}

/**
 * Twin of `Tourney::round_plan`: the rounds a map pool can be bound to.
 *
 * Read off the bracket once it exists, projected from the expected team count
 * before that. The projection is the point: pools are prepared while signups
 * run, and offering nothing until the draw sends the organiser back to the
 * website for the step that has to happen first.
 */
export function roundPlan(event: Tourney): RoundPlan {
  const real: [BracketSide, number][] = [];
  for (const entry of event.matches) {
    if (entry.bracket === "freeForAll") continue;
    if (!real.some(([side, round]) => side === entry.bracket && round === entry.round)) {
      real.push([entry.bracket, entry.round]);
    }
  }
  if (real.length > 0) {
    return { keys: roundKeys(real), projected: false, teams: event.teams.length };
  }

  const teams = projectedTeamCount(event);
  if (teams < 2 || event.competition === "freeForAll") {
    return { keys: [], projected: true, teams };
  }
  const rounds = roundsFor(teams);
  const pairs: [BracketSide, number][] = [];
  if (event.bracketKind === "swiss") {
    for (let round = 1; round <= Math.max(rounds, 1); round += 1) pairs.push(["swiss", round]);
    // A Swiss event plays a final unless its plan turns one off; the plan is
    // not modelled here and its default is on.
    pairs.push(["grandFinal", 1]);
  } else {
    for (let round = 1; round <= rounds; round += 1) pairs.push(["winners", round]);
    if (event.bracketKind === "double") {
      for (let round = 1; round <= Math.max(2 * rounds - 2, 0); round += 1) {
        pairs.push(["losers", round]);
      }
      pairs.push(["grandFinal", 1]);
    }
  }
  return { keys: roundKeys(pairs), projected: true, teams };
}

/**
 * Twin of `BracketConfig::of`: the plan this event would draw with unchanged.
 *
 * The service's own fallbacks, so the dialog opens on what would happen anyway
 * rather than on a blank form: 3 for an ordinary round, 5 for a final.
 */
export function bracketConfigOf(event: Tourney): BracketConfig {
  const rounds = roundsFor(Math.max(event.teams.length, 2));
  if (event.competition === "freeForAll") return { type: "freeForAll" };
  if (event.bracketKind === "swiss") {
    return {
      type: "swiss",
      payload: {
        rounds: Math.max(rounds, 1),
        bestOf: 3,
        finalMatch: true,
        finalBestOf: 5,
        fast: false,
      },
    };
  }
  if (event.bracketKind === "double") {
    return {
      type: "double",
      payload: {
        wb: Array.from({ length: rounds }, () => 3),
        lb: Array.from({ length: Math.max(2 * rounds - 2, 0) }, () => 3),
        gf: 5,
        lbHandicap: true,
      },
    };
  }
  return {
    type: "single",
    payload: { rounds: Array.from({ length: rounds }, (_, index) => (index + 1 === rounds ? 5 : 3)) },
  };
}

/**
 * Twin of `BracketConfig::is_submittable`.
 *
 * Only the counts, because every value is clamped rather than refused: a bad
 * best-of becomes 3. A wrong *number* of rounds is the one that loses a setting
 * without saying so, since the service pads or trims the list to the length the
 * bracket actually has.
 */
export function configIsSubmittable(config: BracketConfig, teams: number): boolean {
  const rounds = roundsFor(Math.max(teams, 2));
  switch (config.type) {
    case "freeForAll":
      return true;
    case "single":
      return config.payload.rounds.length === rounds;
    case "double":
      return (
        config.payload.wb.length === rounds &&
        config.payload.lb.length === Math.max(2 * rounds - 2, 0)
      );
    case "swiss":
      return (
        config.payload.rounds >= 1 &&
        config.payload.rounds <= 15 &&
        (config.payload.bestOf === 1 || config.payload.bestOf === 3)
      );
  }
}

/** Twin of `SeriesDraft::is_submittable`: the service wants a name and nothing else. */
export function seriesIsSubmittable(draft: SeriesDraft): boolean {
  return draft.name.trim() !== "";
}

/** Twin of `MapDraft::is_submittable`: the service wants a name and nothing else. */
export function mapIsSubmittable(draft: MapDraft): boolean {
  return draft.name.trim() !== "";
}

/**
 * Twin of `Tourney::standings_kind`: which table this event has, if any.
 *
 * An import answers with its source's placings even where it has no matches at
 * all, which is the case the elimination table cannot serve.
 */
export function standingsKind(event: Tourney): StandingsKind {
  if (event.imported) return "imported";
  if (!hasBracket(event.status)) return "none";
  if (event.ffa?.mode === "points") return "points";
  if (event.bracketKind === "swiss") return "swiss";
  return "elimination";
}

/**
 * Twin of `Tourney::standings`: the table, in the order it is shown.
 *
 * Worked out here rather than read from the service, because the service sends
 * no table: the website recomputes it in the browser from the matches and each
 * team's exit, and so does the Rust. This is the third implementation of the
 * same rule, which is exactly why it is pinned.
 *
 * Free-for-all points are not covered: that table is summed from a per-match
 * `points` object the client does not model.
 */
export function standings(event: Tourney): Standing[] {
  switch (standingsKind(event)) {
    case "none":
      return [];
    case "swiss":
      return swissStandings(event);
    case "imported":
      return importedStandings(event);
    case "points":
      return pointsStandings(event);
    case "elimination":
      return eliminationStandings(event);
  }
}

const blank = (teamId: string, outcome: Standing["outcome"]): Standing => ({
  teamId,
  place: null,
  outcome,
  wins: 0,
  losses: 0,
  gameDiff: 0,
});

/** A bye counts as a win worth one game, as the service's own table does. */
function swissStandings(event: Tourney): Standing[] {
  const rows = event.teams.map((team) => blank(team.id, "swiss"));
  const at = (id: string | null) =>
    id === null ? -1 : rows.findIndex((row) => row.teamId === id);

  for (const entry of event.matches) {
    if (entry.bracket !== "swiss") continue;
    if (entry.status === "bye") {
      // The absent side is a placeholder rather than a team, so whichever of
      // the two names a real one is who advanced.
      const advanced = [entry.team1, entry.team2].map(at).find((index) => index >= 0);
      if (advanced !== undefined) {
        rows[advanced].wins += 1;
        rows[advanced].gameDiff += 1;
      }
      continue;
    }
    if (entry.status !== "done" || entry.winner === null || entry.loser === null) continue;
    const wonByFirst = entry.winner === entry.team1;
    const high = (wonByFirst ? entry.score1 : entry.score2) ?? 0;
    const low = (wonByFirst ? entry.score2 : entry.score1) ?? 0;
    const margin = high - low;
    const winner = at(entry.winner);
    const loser = at(entry.loser);
    if (winner >= 0) {
      rows[winner].wins += 1;
      rows[winner].gameDiff += margin;
    }
    if (loser >= 0) {
      rows[loser].losses += 1;
      rows[loser].gameDiff -= margin;
    }
  }

  const seedOf = (teamId: string) =>
    event.teams.find((team) => team.id === teamId)?.seed ?? Number.MAX_SAFE_INTEGER;
  rows.sort(
    (left, right) =>
      right.wins - left.wins ||
      right.gameDiff - left.gameDiff ||
      seedOf(left.teamId) - seedOf(right.teamId),
  );
  return rows.map((row, index) => ({
    ...row,
    place: index + 1,
    outcome: row.teamId === event.championTeamId ? "champion" : row.outcome,
  }));
}

/**
 * Points summed over every free-for-all lobby.
 *
 * The champion is pinned to the top regardless of the total: the final decides
 * the event, and a points lead going into it does not.
 */
function pointsStandings(event: Tourney): Standing[] {
  const rows = event.teams.map((team) =>
    blank(
      team.id,
      team.id === event.championTeamId
        ? "champion"
        : team.out !== null
          ? { outIn: { bracket: "freeForAll" as const, round: team.out.round } }
          : "stillIn",
    ),
  );

  for (const entry of event.matches) {
    if (entry.bracket !== "freeForAll") continue;
    for (const scored of entry.points) {
      const row = rows.find((held) => held.teamId === scored.teamId);
      // `wins` carries the total: one row shape for every table.
      if (row !== undefined) row.wins += scored.points;
    }
  }

  const seedOf = (teamId: string) =>
    event.teams.find((team) => team.id === teamId)?.seed ?? Number.MAX_SAFE_INTEGER;
  const crowned = (row: Standing) => (row.teamId === event.championTeamId ? 1 : 0);
  rows.sort(
    (left, right) =>
      crowned(right) - crowned(left) ||
      right.wins - left.wins ||
      seedOf(left.teamId) - seedOf(right.teamId),
  );
  return rows.map((row, index) => ({ ...row, place: index + 1 }));
}

/** The placings an import brought with it. Unplaced teams sort last. */
function importedStandings(event: Tourney): Standing[] {
  const rank = (team: TourneyTeam) => team.finalRank ?? Number.MAX_SAFE_INTEGER;
  return [...event.teams]
    .sort((left, right) => rank(left) - rank(right) || left.seed - right.seed)
    .map((team) => ({
      ...blank(team.id, team.id === event.championTeamId ? "champion" : "placed"),
      place: team.finalRank,
    }));
}

/**
 * How far a run got, as one comparable number. Bigger is further.
 *
 * The bands sit far apart on purpose: losing the grand final beats any number
 * of lower-bracket rounds, and being alive beats having lost at all.
 */
function depthOf(event: Tourney, team: TourneyTeam): number {
  if (team.id === event.championTeamId) return 1_000_000_000;
  if (team.out === null) return 100_000_000;
  if (team.out.bracket === "grandFinal") return 1_000_000;
  if (team.out.bracket === "losers") return 1_000 + team.out.round;
  return team.out.round;
}

/**
 * Rank by how far each run got, champion first.
 *
 * Teams knocked out at the same depth share a place, so a four-team double
 * elimination reads 1, 2, 3, 3 rather than inventing an order between two teams
 * that never played each other.
 */
function eliminationStandings(event: Tourney): Standing[] {
  const ordered = [...event.teams].sort(
    (left, right) => depthOf(event, right) - depthOf(event, left) || left.seed - right.seed,
  );

  const rows: Standing[] = [];
  let previous: number | null = null;
  let place = 0;
  ordered.forEach((team, index) => {
    const depth = depthOf(event, team);
    if (previous !== depth) {
      place = index + 1;
      previous = depth;
    }
    const champion = team.id === event.championTeamId;
    const outcome: Standing["outcome"] = champion
      ? "champion"
      : team.out === null
        ? "stillIn"
        : team.out.bracket === "grandFinal"
          ? "lostFinal"
          : { outIn: { bracket: team.out.bracket, round: team.out.round } };
    rows.push({
      ...blank(team.id, outcome),
      // Still in it means no place yet: calling somebody fourth while they
      // might still win it is worse than leaving it blank.
      place: champion ? 1 : team.out === null ? null : place,
    });
  });
  return rows;
}

/**
 * Twin of `Tourney::may_publish`: whether the event is still waiting to be made
 * visible.
 *
 * The service creates every tournament unpublished and shows it to its own
 * organisers alone, so an event created here and left alone is a draft nobody
 * else can find. It is still taking signups the whole time, which is what makes
 * the missing step easy to miss.
 */
export function mayPublish(event: Tourney): boolean {
  return event.viewer.organiser && !event.published;
}

/**
 * Twin of `Tourney::may_rename`: who may rename or disband a team.
 *
 * An organiser may rename any team as often as needed. A captain gets exactly
 * one, and only where teams hold more than one player: the server counts it in
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
    case "answeringReport":
    case "decidingReport":
    case "vetoing":
    case "reportingFfa":
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
    // Both draft steps run from signups: captains are marked while the field is
    // still open, and starting closes it.
    case "setCaptains":
    case "startDraft":
      return status === "signup";
  }
}

/** Twin of `TourneyState::unread_total`: unread across every room of the open event. */
export function unreadTotal(rooms: ChatRoom[]): number {
  return rooms.reduce((total, room) => total + room.unread, 0);
}

/**
 * What a room's list entry marks itself with.
 *
 * Spelled out rather than imported, like `Standing` above: derived from
 * `ChatRoom` and never part of `AppState`, so specta does not generate it.
 */
export type RoomBadge = "none" | "unread" | "mentioned";

/**
 * Twin of `TourneyState::chat_groups`: the live rooms, and the finished ones.
 *
 * A room per match piles up over a bracket, and the ones whose match is played
 * are noise by the quarter-finals. The service says which by sending `done`;
 * the list folds those into a group that starts collapsed.
 */
export function chatGroups(rooms: ChatRoom[]): { active: ChatRoom[]; completed: ChatRoom[] } {
  return {
    active: rooms.filter((room) => !room.done),
    completed: rooms.filter((room) => room.done),
  };
}

/**
 * Twin of `TourneyState::completed_wants_attention`.
 *
 * Being named by `@` in a room that is folded away would otherwise be
 * invisible, which is the one thing hiding finished rooms costs.
 */
export function completedWantsAttention(rooms: ChatRoom[]): boolean {
  return rooms.some((room) => room.done && room.mentioned);
}

/**
 * Twin of `ChatRoom::badge`: one mark at a time, in the order a reader cares.
 *
 * Being named beats a room having moved on. The organiser bell is not in here
 * because it is drawn alongside rather than instead, and only for organisers.
 */
export function roomBadge(room: ChatRoom): RoomBadge {
  if (room.mentioned) return "mentioned";
  if (room.unread > 0) return "unread";
  return "none";
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
