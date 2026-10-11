// The Overview's own rules: the early-stop countdown and the Recent results
// list, as the website's `drawOverview` and `fillQueue` compute them.
//
// Presentation only, so no conformance twin: nothing here decides anything the
// service does not already know. Kept pure so a test can read each rule
// without rendering the page.

import type { MessageKey, MessageValues } from "../../i18n";
import type { Tourney, TourneyMatch } from "../../ipc/bindings";
import { roundKeyOf } from "../../shared/rules/tourneyRules";

type Translate = (key: MessageKey, values?: MessageValues) => string;

/**
 * The element id of the Players section's rating check, which the Overview's
 * "Don't know your rating?" link scrolls to.
 */
export const RATING_CHECK_ID = "tournament-rating-check";

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
