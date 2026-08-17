// Builders for the tournament tests.
//
// `Tourney` has thirty-odd fields and almost every test cares about two of
// them, so the defaults live here rather than being retyped per file.

import type {
  Tourney,
  TourneyMatch,
  TourneyPlayer,
  TourneyTeam,
} from "../../ipc/bindings";

export function tourney(over: Partial<Tourney> = {}): Tourney {
  return {
    id: "e1a2b",
    name: "",
    description: "",
    status: "running",
    category: "community",
    competition: "team",
    formation: "solo",
    bracketKind: "double",
    teamSize: 1,
    divisions: 0,
    playerReporting: true,
    vetoEnabled: false,
    rating: { min: null, max: null, maxTeam: null, cap: null },
    createdAt: null,
    eventDate: null,
    signupOpensAt: null,
    signupClosesAt: null,
    checkInOpensAt: null,
    checkInDeadline: null,
    chatLocked: false,
    playerCount: 0,
    teamCount: 0,
    players: [],
    teams: [],
    matches: [],
    mapDb: [],
    mapPools: [],
    poolAssign: [],
    organisers: [],
    news: [],
    invites: [],
    championTeamId: null,
    viewer: {
      loggedIn: true,
      organiser: false,
      fafId: 101,
      fafName: "",
      signedUpPlayerId: null,
      memberTeamId: null,
      unreadByRoom: [],
    },
    ...over,
  };
}

export function player(over: Partial<TourneyPlayer> = {}): TourneyPlayer {
  return {
    id: "p1",
    name: "",
    fafId: 101,
    rating: 1640,
    ratingActual: 1640,
    teamId: "t1",
    manual: false,
    late: false,
    pending: false,
    note: "",
    signedAt: null,
    ...over,
  };
}

export function team(over: Partial<TourneyTeam> = {}): TourneyTeam {
  return {
    id: "t1",
    name: "",
    seed: 1,
    captainId: "p1",
    playerIds: ["p1"],
    division: 0,
    checkedIn: false,
    eliminated: false,
    finalRank: null,
    joinRequests: [],
    invites: [],
    ...over,
  };
}

export function match(over: Partial<TourneyMatch> = {}): TourneyMatch {
  return {
    id: "m1",
    bracket: "winners",
    round: 1,
    index: 0,
    bestOf: 3,
    handicap: 0,
    division: 0,
    team1: "t1",
    team2: "t2",
    score1: null,
    score2: null,
    status: "ready",
    winner: null,
    loser: null,
    winnerTo: null,
    loserTo: null,
    pendingReport: null,
    replayIds: [],
    ...over,
  };
}
