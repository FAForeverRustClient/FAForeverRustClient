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
  ChatRoom,
  GalacticWarState,
  Review,
  ReviewSummary,
  Tourney,
  TourneyAction,
  TourneyDraft,
  TourneyMap,
  TourneyMatch,
  TourneyPhase,
  TourneyStatus,
  UploadsState,
  VaultMap,
} from "../ipc/bindings";
import fixture from "./__fixtures__/reducer-conformance.json";
import { canLaunch, installTarget, updateAvailable } from "../shared/galacticWarActions";
import { noteForPlayer } from "../shared/playerNotes";
import {
  busyMatchId,
  type DraftRejection,
  isLegalFrom,
  isSubmittable,
  mapKey,
  matchVaultMap,
  mayReseed,
  myInvites,
  newGames,
  openEvent,
  pendingSignups,
  rejectionOf,
  selfOrganised,
  teamMembers,
  teamRating,
  unreadTotal,
  wouldExceedCap,
} from "../features/tournaments/tourneyPresentation";
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
    name: string;
    event: Tourney;
    teamId: string | null;
    teamRating: number;
    wouldExceedTeamCap: boolean;
    selfOrganised: boolean;
    mayReseed: boolean;
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
  tourneyMapMatches: {
    vault: Array<{ displayName: string; folderName: string }>;
    cases: Array<{ typed: string; key: string; resolvedDisplayName: string | null }>;
  };
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
      pendingSignupIds: pendingSignups(event).map((player) => player.id),
      memberIds: team === null ? [] : teamMembers(event, team).map((player) => player.id),
      myInviteTeamIds: myInvites(event).map((held) => held.id),
      unreadTotal: unreadTotal(recorded.rooms),
    }).toEqual({
      teamRating: recorded.teamRating,
      wouldExceedTeamCap: recorded.wouldExceedTeamCap,
      selfOrganised: recorded.selfOrganised,
      mayReseed: recorded.mayReseed,
      pendingSignupIds: recorded.pendingSignupIds,
      memberIds: recorded.memberIds,
      myInviteTeamIds: recorded.myInviteTeamIds,
      unreadTotal: recorded.unreadTotal,
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
      ...recorded.entry,
    } as TourneyMatch;
    expect({
      newGames: newGames(entry, recorded.score1, recorded.score2),
      submittable: isSubmittable(entry, recorded.score1, recorded.score2),
    }).toEqual({ newGames: recorded.newGames, submittable: recorded.submittable });
  });

  it.each(helpers.tourneyMapMatches.cases)(
    'resolves the typed map name "$typed"',
    ({ typed, key, resolvedDisplayName }) => {
      const vault = helpers.tourneyMapMatches.vault as VaultMap[];
      const tourneyMap = { id: "m", name: typed, imageUrl: "" } satisfies TourneyMap;
      expect({
        key: mapKey(typed),
        resolved: matchVaultMap(tourneyMap, vault)?.displayName ?? null,
      }).toEqual({ key, resolved: resolvedDisplayName });
    },
  );
});
