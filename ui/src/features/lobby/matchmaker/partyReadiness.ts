// Who counts as "in a game" when a search is about to start.
//
// Java's `partyMembersNotReady`: nobody in the party may be in a game, a lobby
// included, because the server refuses the search otherwise. What it means by
// a lobby is one a player sat down in. The automatic lobby the server opens
// for a matchmaker match is not that: when the match is cancelled before it
// launches, that lobby can stay listed as "initiating" for minutes, and
// counting it locked the player out of searching again until a restart (#443).

import type { Game } from "../../../ipc/bindings";
import { allGamePlayers } from "../../../shared/liveReplayModel";

function isMatchmakerLobby(game: Game): boolean {
  return game.gameType.toLocaleLowerCase() === "matchmaker" && game.launchedAt === null;
}

/** Everybody seated in a running game or in a lobby they joined themselves. */
export function playersInGames(openGames: readonly Game[], liveGames: readonly Game[]): Set<string> {
  return new Set(
    [...openGames.filter((game) => !isMatchmakerLobby(game)), ...liveGames].flatMap((game) => allGamePlayers(game)),
  );
}
