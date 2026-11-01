// A tournament's draft, built from nothing or from an existing event: the pure
// half of the form, apart from the form so that the create starters can build
// a draft from an earlier event without importing the form that renders them.

import type { Tourney, TourneyDraft } from "../../../ipc/bindings";
import { defaultPlanFor } from "../../../shared/rules/tourneyRules";

/** The draft an existing event would produce, for the edit case. */
export function draftOf(event: Tourney): TourneyDraft {
  return {
    // Only read on creation.
    proposal: false,
    name: event.name,
    description: event.description,
    category: event.category,
    competition: event.competition,
    teamSize: event.teamSize,
    formation: event.formation,
    bracketKind: event.bracketKind,
    // Read off the event, not assumed. `edit_info` sends `signupMode`, so a
    // hardcoded "open" here reopened an invite-only event to everyone the
    // first time its organiser corrected a typo in the name.
    //
    // `seeding` was the last of those guesses: it sat here as a literal
    // "rating" because nothing read the field, so an event seeded randomly or
    // by hand answered "by rating" the moment its organiser opened this form.
    // The codec reads it now, so the form can say what is actually set.
    seeding: event.seeding,
    rewards: event.rewards,
    sponsors: event.sponsors,
    lobbyOptions: event.lobbyOptions,
    mods: event.mods,
    prize: event.prize,
    streams: event.streams,
    seriesId: event.seriesId,
    plan: event.plan,
    veto: event.veto,
    minTeams: event.minTeams,
    draftSnakes: event.draftSnakes,
    ratingKind: event.ratingKind,
    signupMode: event.signupMode,
    eventDate: event.eventDate,
    signupOpensAt: event.signupOpensAt,
    signupClosesAt: event.signupClosesAt,
    ratingDate: event.ratingDate,
    rating: event.rating,
    maxTeams: 0,
    // The event's own value: `edit_info` always sends it, and the service
    // reads an absent one as on.
    playerReporting: event.playerReporting,
    // Both always sent by `edit_info` too, so both are the event's own.
    checkInDeadline: event.checkInDeadline,
    eventDays: event.eventDays,
    // The format is the Format panel's to change once the event exists; these
    // are carried so the draft is whole, and `edit_info` does not send them.
    presetId: null,
    swiss: { cuts: event.swissCuts, decidingBestOf: event.decidingBestOf, stageTwo: event.stageTwoPlan },
    picks: { on: event.pickOpponents, minutes: event.pickMinutes, mode: event.pickMode },
    tiebreak: event.swissTiebreak,
    stopAtAlive: event.stopAtAlive,
    ffa: event.ffa,
  };
}

/** A new event's draft before the organiser has answered anything. */
export const BLANK_DRAFT: TourneyDraft = {
  proposal: false,
  name: "",
  description: "",
  category: "community",
  competition: "team",
  teamSize: 2,
  formation: "open",
  bracketKind: "single",
  seeding: "rating",
  rewards: "",
  sponsors: "",
  lobbyOptions: "",
  mods: "",
  prize: null,
  streams: [],
  seriesId: null,
  plan: defaultPlanFor("single"),
  veto: { enabled: false, mode: "upfront", teamA: "lowerA", revealBans: false },
  minTeams: 0,
  draftSnakes: false,
  ratingKind: "global",
  signupMode: "open",
  playerReporting: true,
  eventDate: null,
  signupOpensAt: null,
  signupClosesAt: null,
  ratingDate: null,
  rating: { min: null, max: null, maxTeam: null, cap: null },
  maxTeams: 0,
  checkInDeadline: null,
  eventDays: [],
  presetId: null,
  swiss: { cuts: { wins: 0, losses: 0 }, decidingBestOf: 0, stageTwo: null },
  picks: { on: false, minutes: 0, mode: "half" },
  tiebreak: "gameDiff",
  stopAtAlive: 0,
  ffa: null,
};
