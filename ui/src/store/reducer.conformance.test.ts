// Conformance: the frontend reducer must agree with the Rust one.
//
// `reducers/*.ts` are hand-written twins of `crates/faf-domain/src/state/`.
// TypeScript's exhaustive switch catches a *missing* event variant; nothing
// catches the same variant taking a different transition, and nothing
// reconciles the two at runtime: `src-tauri` re-sends a full snapshot only
// when the event broadcast lags. A divergence therefore persists silently.
//
// The fixture is written by `crates/faf-domain/tests/conformance_fixtures.rs`
// on every `cargo test`, and records what `faf_domain::reduce` *actually*
// does. That matters: a hand-written expectation here would only encode
// someone's reading of the Rust: the same reading that produced the one
// divergence already found (`userLeft` creating a chat channel).
//
// If this fails after a Rust change, the twin has not kept up. Fix the twin,
// not the fixture.

import { describe, expect, it } from "vitest";
import type {
  AppEvent,
  AppState,
  BracketConfig,
  ChatRoom,
  FfaReport,
  GalacticWarState,
  PlayerSummary,
  FormatDraft,
  PoolDraft,
  QualifierRule,
  Review,
  ReviewSummary,
  Tourney,
  TourneyAction,
  TourneyDraft,
  TourneyMap,
  TourneyMatch,
  TourneyPhase,
  TourneyPlayer,
  TourneyStatus,
  UploadsState,
  VaultMap,
} from "../ipc/bindings";
import type { BracketKind, MatchPlan } from "../ipc/bindings";
import fixture from "./__fixtures__/reducer-conformance.json";
import { canLaunch, installTarget, updateAvailable } from "../shared/galacticWarActions";
import { noteForPlayer } from "../shared/playerNotes";
import {
  bracketConfigOf,
  defaultPlanFor,
  busyMatchId,
  chatGroups,
  configIsSubmittable,
  completedWantsAttention,
  draftTurn,
  type DraftRejection,
  ffaIsScored,
  ffaReportIsSubmittable,
  ffaWinnersNeeded,
  isLegalFrom,
  isStructural,
  isSubmittable,
  mapKey,
  matchVaultMap,
  mayEditFormat,
  mayEditTeamSetup,
  mayPostChat,
  mayReseed,
  maySetRating,
  mayShuffleTeams,
  mayPublish,
  mayRename,
  mayPick,
  mayReport,
  mayReportFfa,
  maySetVetoSides,
  mayVeto,
  mayUndoPick,
  myInvites,
  newGames,
  openEvent,
  pendingSignups,
  poolRejection,
  qualifierRejection,
  type PoolRejection,
  type QualifierRejection,
  profileOf,
  rejectionOf,
  roomBadge,
  type RoomBadge,
  roundPlan,
  type RoundPlan,
  selfOrganised,
  type Standing,
  standings,
  type StandingsKind,
  standingsKind,
  teamMembers,
  teamRating,
  undrafted,
  unreadNews,
  unreadTotal,
  vetoTurn,
  wouldExceedCap,
} from "../shared/tourneyRules";
import { applyEvent } from "./reducer";
import { summarize } from "./reducers/reviews";
import { isUploadBusy } from "./reducers/uploads";
import { useAppStore } from "./store";

interface Step {
  event: AppEvent;
  expected: unknown;
}

interface Case {
  name: string;
  steps: Step[];
}

interface HelperFixture {
  reviewSummaries: Array<{ reviews: Review[]; expected: ReviewSummary }>;
  uploadBusy: Array<{ status: UploadsState["status"]; expected: boolean }>;
  playerNoteLookups: Array<{
    notes: AppState["settings"]["social"]["playerNotes"];
    playerId: number;
    expected: string;
  }>;
  galacticWarActions: Array<{
    state: GalacticWarState;
    installTarget: string;
    updateAvailable: boolean;
    canLaunch: boolean;
  }>;
  tourneyRules: Array<{
    mayPublish: boolean;
    mayRename: boolean;
    reportableMatchIds: string[];
    name: string;
    event: Tourney;
    teamId: string | null;
    teamRating: number;
    wouldExceedTeamCap: boolean;
    selfOrganised: boolean;
    mayReseed: boolean;
    mayShuffleTeams: boolean;
    maySetRating: boolean;
    pendingSignupIds: string[];
    memberIds: string[];
    myInviteTeamIds: string[];
    rooms: ChatRoom[];
    unreadTotal: number;
  }>;
  tourneyBusyMatches: Array<{
    pending: TourneyAction | null;
    busyMatchId: string | null;
  }>;
  tourneyOpenEvents: Array<{
    detailId: string | null;
    selectedId: string | null;
    openId: string | null;
  }>;
  tourneyPhaseLegality: Array<{
    phase: TourneyPhase;
    status: TourneyStatus;
    legal: boolean;
  }>;
  tourneyDraftRejections: Array<{
    name: string;
    draft: TourneyDraft;
    rejection: DraftRejection | null;
    submittable: boolean;
  }>;
  tourneyReports: Array<{
    name: string;
    entry: { bestOf: number; handicap: number; score1: number | null; score2: number | null };
    score1: number;
    score2: number;
    replayIds: string[];
    newGames: number;
    submittable: boolean;
  }>;
  tourneyProfiles: Array<{
    name: string;
    profiles: PlayerSummary[];
    entrant: TourneyPlayer;
    resolvedLogin: string | null;
  }>;
  tourneyPoolDrafts: Array<{
    name: string;
    draft: PoolDraft;
    rejection: PoolRejection | null;
    submittable: boolean;
  }>;
  tourneyDrafts: Array<{
    name: string;
    event: Tourney;
    turnTeamId: string | null;
    mayPick: boolean;
    mayUndo: boolean;
    undraftedIds: string[];
  }>;
  tourneyFfa: Array<{
    name: string;
    event: Tourney;
    report: FfaReport;
    winnersNeeded: number;
    scored: boolean;
    mayReport: boolean;
    submittable: boolean;
  }>;
  tourneyVetoes: Array<{
    name: string;
    event: Tourney;
    turnTeamId: string | null;
    mayVeto: boolean;
    maySetSides: boolean;
  }>;
  tourneyStandings: Array<{
    name: string;
    event: Tourney;
    kind: StandingsKind;
    rows: Standing[];
  }>;
  tourneyMapMatches: {
    vault: Array<{ displayName: string; folderName: string }>;
    cases: Array<{ typed: string; key: string; resolvedDisplayName: string | null }>;
  };
  tourneyQualifiers: Array<{
    name: string;
    event: Tourney;
    candidate: Tourney;
    rule: QualifierRule;
    rejection: QualifierRejection | null;
  }>;
  tourneyMatchPlans: Array<{
    kind: BracketKind;
    expected: MatchPlan;
  }>;
  tourneyBracketConfigs: Array<{
    name: string;
    event: Tourney;
    config: BracketConfig;
    submittable: boolean;
  }>;
  tourneyChatRooms: Array<{
    name: string;
    rooms: ChatRoom[];
    active: string[];
    completed: string[];
    completedWantsAttention: boolean;
    badges: RoomBadge[];
  }>;
  tourneyRounds: Array<{
    name: string;
    event: Tourney;
    plan: RoundPlan;
  }>;
  tourneyLifecycles: Array<{
    name: string;
    event: Tourney;
    mayEditFormat: boolean;
    mayEditTeamSetup: boolean;
    mayPostChat: boolean;
    unreadNews: number;
    format: FormatDraft;
    structural: boolean;
  }>;
}

const cases = fixture.cases as unknown as Case[];
const initial = fixture.initial as unknown as AppState;
const helpers = fixture.helpers as unknown as HelperFixture;

describe("the frontend reducer matches the Rust one", () => {
  it("has cases to run", () => {
    // Guards against an empty or half-written fixture quietly passing.
    expect(cases.length).toBeGreaterThan(0);
    expect(cases.every((testCase) => testCase.steps.length > 0)).toBe(true);
  });

  it.each(cases.map((testCase) => [testCase.name, testCase] as const))(
    "%s",
    (_name, testCase) => {
      let state = initial;
      testCase.steps.forEach((step, index) => {
        const before = state;
        state = applyEvent(state, step.event);
        const slice = `${step.event.kind[0].toLowerCase()}${step.event.kind.slice(1)}` as keyof AppState;
        const context = `after step ${index + 1}: ${JSON.stringify(step.event)}`;
        expect(state[slice], context).toEqual(step.expected);
        for (const otherSlice of Object.keys(before) as Array<keyof AppState>) {
          if (otherSlice !== slice) {
            expect(state[otherSlice], `${context}; unexpected change in ${otherSlice}`).toEqual(
              before[otherSlice],
            );
          }
        }
      });
    },
  );
});

describe("the store's initial state", () => {
  it("matches `AppState::default()` exactly", () => {
    // The frontend's INITIAL is hand-maintained alongside every new slice. If
    // it drifts, the client renders from a state the backend has never been
    // in: until the first event for that slice arrives, which for a slice
    // nobody touches may be never.
    expect(useAppStore.getState().state).toEqual(initial);
  });
});

describe("derived helper twins match Rust", () => {
  it.each(helpers.reviewSummaries)("summarizes reviews", ({ reviews, expected }) => {
    expect(summarize(reviews)).toEqual(expected);
  });

  it.each(helpers.uploadBusy)("classifies upload status $status.type", ({ status, expected }) => {
    expect(isUploadBusy(status)).toBe(expected);
  });

  it.each(helpers.playerNoteLookups)("finds player note $playerId", ({ notes, playerId, expected }) => {
    expect(noteForPlayer(notes, playerId)).toBe(expected);
  });

  it.each(helpers.galacticWarActions)(
    "decides the galactic war action for $state.installedVersion / $state.status.type",
    ({ state, ...expected }) => {
      expect({
        installTarget: installTarget(state),
        updateAvailable: updateAvailable(state),
        canLaunch: canLaunch(state),
      }).toEqual(expected);
    },
  );
});

// The tournament panes gate real controls on these: whether a join button is
// drawn, whether the seeding section exists, whether the bracket on screen
// belongs to the row that is open. Each was a hand-written twin with nothing
// checking it, which is how a control that the server refuses gets offered.
describe("tournament rule twins match Rust", () => {
  it.each(helpers.tourneyRules)("$name", (recorded) => {
    const { event, teamId } = recorded;
    const team = teamId === null ? null : (event.teams.find((held) => held.id === teamId) ?? null);
    expect({
      teamRating: team === null ? 0 : teamRating(event, team),
      wouldExceedTeamCap: team === null ? false : wouldExceedCap(event, team),
      selfOrganised: selfOrganised(event),
      mayReseed: mayReseed(event),
      mayShuffleTeams: mayShuffleTeams(event),
      maySetRating: maySetRating(event),
      pendingSignupIds: pendingSignups(event).map((player) => player.id),
      memberIds: team === null ? [] : teamMembers(event, team).map((player) => player.id),
      myInviteTeamIds: myInvites(event).map((held) => held.id),
      unreadTotal: unreadTotal(recorded.rooms),
      mayPublish: mayPublish(event),
      mayRename: team === null ? false : mayRename(event, team),
      // Ids rather than a count: `may_report` turns on the event status as much
      // as on the match, and the twin had silently dropped the status half while
      // it lived inside `BracketView.tsx` where nothing could pin it.
      reportableMatchIds: event.matches
        .filter((entry) => mayReport(event, entry))
        .map((entry) => entry.id),
    }).toEqual({
      teamRating: recorded.teamRating,
      wouldExceedTeamCap: recorded.wouldExceedTeamCap,
      selfOrganised: recorded.selfOrganised,
      mayReseed: recorded.mayReseed,
      mayShuffleTeams: recorded.mayShuffleTeams,
      maySetRating: recorded.maySetRating,
      pendingSignupIds: recorded.pendingSignupIds,
      memberIds: recorded.memberIds,
      myInviteTeamIds: recorded.myInviteTeamIds,
      unreadTotal: recorded.unreadTotal,
      mayPublish: recorded.mayPublish,
      mayRename: recorded.mayRename,
      reportableMatchIds: recorded.reportableMatchIds,
    });
  });

  it.each(helpers.tourneyBusyMatches)(
    "narrows the pending write $pending.type to match $busyMatchId",
    ({ pending, busyMatchId: expected }) => {
      expect(busyMatchId(pending)).toBe(expected);
    },
  );

  it.each(helpers.tourneyOpenEvents)(
    "opens detail $detailId under selection $selectedId",
    ({ detailId, selectedId, openId }) => {
      const detail = detailId === null ? null : ({ id: detailId } as Tourney);
      expect(openEvent(detail, selectedId)?.id ?? null).toBe(openId);
    },
  );

  it.each(helpers.tourneyPhaseLegality)(
    "allows $phase from $status: $legal",
    ({ phase, status, legal }) => {
      expect(isLegalFrom(phase, status)).toBe(legal);
    },
  );

  // The first refusal is the one the form shows, so the *order* is pinned as
  // much as the rules: a draft with two problems must name the same one the
  // server would.
  it.each(helpers.tourneyDraftRejections)("refuses a draft: $name", ({ draft, ...expected }) => {
    expect({ rejection: rejectionOf(draft), submittable: rejectionOf(draft) === null }).toEqual({
      rejection: expected.rejection,
      submittable: expected.submittable,
    });
  });

  // The highest-stakes rule in the tab: saying yes where the Rust says no throws
  // away a player's reported score.
  it.each(helpers.tourneyReports)("judges a report: $name", (recorded) => {
    // Only the fields both rules read are recorded, so the rest is filler.
    const entry = {
      id: "m1",
      bracket: "winners",
      round: 1,
      index: 0,
      division: 0,
      team1: "t1",
      team2: "t2",
      status: "ready",
      winner: null,
      loser: null,
      winnerTo: null,
      loserTo: null,
      pendingReport: null,
      replayIds: [],
      veto: null,
      entrants: [],
      winners: [],
      points: [],
      isFinal: false,
      ...recorded.entry,
    } as TourneyMatch;
    expect({
      newGames: newGames(entry, recorded.score1, recorded.score2),
      submittable: isSubmittable(entry, recorded.score1, recorded.score2),
    }).toEqual({ newGames: recorded.newGames, submittable: recorded.submittable });
  });

  it.each(helpers.tourneyProfiles)("resolves $name", (recorded) => {
    expect(profileOf(recorded.profiles, recorded.entrant)?.login ?? null).toBe(
      recorded.resolvedLogin,
    );
  });

  // Two counting rules that the service states as arithmetic after the fact.
  // Getting them wrong here means an organiser fills the form, sends it, and is
  // handed numbers to work backwards from.
  it.each(helpers.tourneyPoolDrafts)("judges a pool: $name", (recorded) => {
    expect({
      rejection: poolRejection(recorded.draft),
      submittable: poolRejection(recorded.draft) === null,
    }).toEqual({ rejection: recorded.rejection, submittable: recorded.submittable });
  });

  // The same arithmetic the round projection uses, and wrong in the same quiet
  // way: the service trims the list to the bracket's real length, so one row
  // too few loses a round's setting without saying so.
  // The defaults the create form opens on. Pinned because they exist twice and
  // a difference between them is invisible until an event is played.
  it.each(helpers.tourneyMatchPlans)("defaults the match plan for $kind", (recorded) => {
    expect(defaultPlanFor(recorded.kind)).toEqual(recorded.expected);
  });

  it.each(helpers.tourneyBracketConfigs)("plans the draw: $name", (recorded) => {
    const config = bracketConfigOf(recorded.event);
    expect({ config, submittable: configIsSubmittable(config, recorded.event.teams.length) }).toEqual(
      { config: recorded.config, submittable: recorded.submittable },
    );
  });

  // The split the tournament team asked for: a bracket makes a room per match
  // and never deletes one, so the played ones fold away or the live list is
  // unusable by the quarter-finals.
  it.each(helpers.tourneyChatRooms)("groups the chat rooms: $name", (recorded) => {
    const { active, completed } = chatGroups(recorded.rooms);
    expect({
      active: active.map((room) => room.id),
      completed: completed.map((room) => room.id),
      completedWantsAttention: completedWantsAttention(recorded.rooms),
      badges: recorded.rooms.map(roomBadge),
    }).toEqual({
      active: recorded.active,
      completed: recorded.completed,
      completedWantsAttention: recorded.completedWantsAttention,
      badges: recorded.badges,
    });
  });

  // Arithmetic that is easy to get subtly wrong on one side only, and a client
  // that offered one round too few would leave a real round with no map pool
  // and nobody looking for it.
  it.each(helpers.tourneyRounds)("plans the rounds: $name", (recorded) => {
    expect(roundPlan(recorded.event)).toEqual(recorded.plan);
  });

  // The two format answers lock one step apart: the whole format at the draw,
  // the team setup one step earlier at the end of signups. `structural` is the
  // load-bearing one, because the service refuses those keys on presence alone.
  it.each(helpers.tourneyLifecycles)("gates the event: $name", (recorded) => {
    expect({
      mayEditFormat: mayEditFormat(recorded.event),
      mayEditTeamSetup: mayEditTeamSetup(recorded.event),
      mayPostChat: mayPostChat(recorded.event),
      unreadNews: unreadNews(recorded.event),
      structural: isStructural(recorded.format, recorded.event),
    }).toEqual({
      mayEditFormat: recorded.mayEditFormat,
      mayEditTeamSetup: recorded.mayEditTeamSetup,
      mayPostChat: recorded.mayPostChat,
      unreadNews: recorded.unreadNews,
      structural: recorded.structural,
    });
  });

  // Three of these four mirror a refusal the service makes. The fourth does
  // not: a points rule against an elimination bracket is accepted and then
  // qualifies nobody, so a drift here is invisible until the invites do not
  // arrive.
  it.each(helpers.tourneyQualifiers)("judges a qualifier link: $name", (recorded) => {
    expect(qualifierRejection(recorded.event, recorded.candidate, recorded.rule)).toEqual(
      recorded.rejection,
    );
  });

  // The undo rule is the subtle one: an organiser may take back any pick, a
  // captain only their own and only while nobody has picked after them.
  it.each(helpers.tourneyDrafts)("drafts $name", (recorded) => {
    expect({
      turnTeamId: draftTurn(recorded.event),
      mayPick: mayPick(recorded.event),
      mayUndo: mayUndoPick(recorded.event),
      undraftedIds: undrafted(recorded.event).map((player) => player.id),
    }).toEqual({
      turnTeamId: recorded.turnTeamId,
      mayPick: recorded.mayPick,
      mayUndo: recorded.mayUndo,
      undraftedIds: recorded.undraftedIds,
    });
  });

  // Three rules that interlock: the winner count is capped by the field, a
  // points event still decides its flagged final by a winner, and a scored
  // round needs a number for every entrant rather than the ones typed.
  it.each(helpers.tourneyFfa)("judges a free-for-all lobby: $name", (recorded) => {
    const entry = recorded.event.matches[0];
    const scored = ffaIsScored(recorded.event, entry);
    const needed = ffaWinnersNeeded(recorded.event, entry);
    expect({
      winnersNeeded: needed,
      scored,
      mayReport: mayReportFfa(recorded.event, entry),
      submittable: ffaReportIsSubmittable(recorded.report, entry, scored, needed),
    }).toEqual({
      winnersNeeded: recorded.winnersNeeded,
      scored: recorded.scored,
      mayReport: recorded.mayReport,
      submittable: recorded.submittable,
    });
  });

  // Two captains act on one run concurrently. Getting the turn wrong shows one
  // of them a button that answers "Not your turn" and the other nothing.
  it.each(helpers.tourneyVetoes)("vetoes $name", (recorded) => {
    const entry = recorded.event.matches[0];
    expect({
      turnTeamId: entry.veto === null ? null : (vetoTurn(entry.veto)?.teamId ?? null),
      mayVeto: mayVeto(recorded.event, entry),
      maySetSides: maySetVetoSides(recorded.event, entry),
    }).toEqual({
      turnTeamId: recorded.turnTeamId,
      mayVeto: recorded.mayVeto,
      maySetSides: recorded.maySetSides,
    });
  });

  // The standings are the same rule written three times: Rust, this twin, and
  // the website's own. The service sends no table, so nothing external would
  // catch them disagreeing, and the order is as load-bearing as the numbers.
  it.each(helpers.tourneyStandings)("stands $name", (recorded) => {
    expect({
      kind: standingsKind(recorded.event),
      rows: standings(recorded.event),
    }).toEqual({ kind: recorded.kind, rows: recorded.rows });
  });

  it.each(helpers.tourneyMapMatches.cases)(
    'resolves the typed map name "$typed"',
    ({ typed, key, resolvedDisplayName }) => {
      const vault = helpers.tourneyMapMatches.vault as VaultMap[];
      const tourneyMap = {
        id: "m",
        name: typed,
        imageUrl: "",
        description: "",
        published: true,
      } satisfies TourneyMap;
      expect({
        key: mapKey(typed),
        resolved: matchVaultMap(tourneyMap, vault)?.displayName ?? null,
      }).toEqual({ key, resolved: resolvedDisplayName });
    },
  );
});
