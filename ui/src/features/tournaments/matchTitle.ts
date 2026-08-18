// The lobby title for a tournament match.
//
// Lives in the frontend alone: it is derived from two things the tab already
// holds, and it is only ever used to prefill the host dialog, so sending a
// rendered string per match would grow every bracket payload for nothing.

import type { BracketSide, Tourney, TourneyMatch } from "../../ipc/bindings";

/** `HostGameConfig::MAX_TITLE_CHARS`: the lobby server rejects anything longer. */
const MAX_TITLE_CHARS = 128;

/**
 * What an undecided slot is called in the title.
 *
 * Deliberately not translated: the result is a lobby name every player on the
 * server sees, so it has to read the same for all of them.
 */
const UNDECIDED_SLOT = "TBD";

/**
 * The round's short form.
 *
 * The two halves of a double-elimination event both have a round 2, and they
 * are not interchangeable to somebody scanning the custom-games list for their
 * match, so the losers' side is marked. The grand final has one round and does
 * not need a number at all.
 */
function roundTag(bracket: BracketSide, round: number): string {
  switch (bracket) {
    case "losers":
      return `LR${round}`;
    case "grandFinal":
      return "GF";
    case "swiss":
      return `SR${round}`;
    default:
      return `R${round}`;
  }
}

/**
 * The lobby title for one of an event's matches, e.g.
 * `Weekend Cup R2: Nuggets vs Ada`.
 */
export function matchTitle(event: Tourney, entry: TourneyMatch): string {
  const nameOf = (teamId: string | null): string => {
    if (teamId === null) return UNDECIDED_SLOT;
    const team = event.teams.find((candidate) => candidate.id === teamId);
    if (team === undefined) return UNDECIDED_SLOT;
    // The team's own name when it has one, else the first player added, which
    // is what an organiser expects for a solo event.
    const named = team.name.trim();
    if (named !== "") return named;
    const first = event.players.find((player) => player.id === team.playerIds[0]);
    const login = first?.name.trim() ?? "";
    return login === "" ? UNDECIDED_SLOT : login;
  };

  const pairing = `${roundTag(entry.bracket, entry.round)}: ${nameOf(entry.team1)} vs ${nameOf(entry.team2)}`;
  const name = event.name.trim();
  const full = name === "" ? pairing : `${name} ${pairing}`;
  if ([...full].length <= MAX_TITLE_CHARS) return full;
  // Over the limit: drop the event name rather than cutting the pairing in
  // half, and only then truncate.
  return [...pairing].slice(0, MAX_TITLE_CHARS).join("");
}
