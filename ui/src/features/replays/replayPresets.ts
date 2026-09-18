// Which of the three scope buttons above a replay search is the one currently
// in force.
//
// The buttons on the left of the divider replace the search rather than narrow
// it, so exactly one of them describes any given query. They were drawn as
// three identical buttons all the same, while the toggles to their right invert
// when they are on: the report was that the active filter is not visible, and
// what makes it visible is knowing which one it is.
//
// Derived from the query rather than remembered alongside it. A preset is not a
// mode the form is in; it is a shape the query has, and it can also be arrived
// at by hand, by a search handed over from a player card, or by restoring one
// from the last session. Remembering the press would light the wrong button in
// all three cases.

import type { ReplayQuery } from "../../ipc/bindings";
import type { LocalReplayQuery } from "./localReplayQuery";
import { isRecentBound } from "../../shared/replayQuery";

/** The scope buttons the online vault offers, left to right. */
export type ReplayPreset = "newest" | "highestRated" | "own";

/** The scope buttons the local archive offers, left to right. */
export type LocalReplayPreset = "newest" | "lastYear" | "own";

/**
 * Whether a query is scoped to the signed in account.
 *
 * Case insensitive, because the name can arrive from the query string of a
 * search somebody else handed over as well as from the account itself, and FAF
 * logins are matched without regard to case everywhere else.
 */
function isOwn(player: string, exactPlayer: boolean, self: string): boolean {
  return (
    self !== ""
    && exactPlayer
    && player.toLocaleLowerCase() === self.toLocaleLowerCase()
  );
}

/**
 * The online vault's active scope.
 *
 * "Best reviewed" is recognised by the two fields the preset sets that nothing
 * else does: a review floor, and sorting by review score. A query that merely
 * sorts by score is not it, because the preset's point is the floor.
 *
 * Everything that is neither of the other two is "All replays", including a
 * search for somebody else's name. That is what the button means: it is the
 * unrestricted scope, not an empty form.
 */
export function activeReplayPreset(query: ReplayQuery, self: string): ReplayPreset {
  if (isOwn(query.player, query.exactPlayer, self)) return "own";
  if (query.minReviewScore !== null && query.sortBy === "reviewScore") return "highestRated";
  return "newest";
}

/**
 * The local archive's active scope.
 *
 * "Last year" is a date bound and nothing else, so it only counts while the
 * query is not scoped to a player: the two are separate buttons and only one of
 * them can be lit.
 */
export function activeLocalReplayPreset(
  query: LocalReplayQuery,
  self: string,
): LocalReplayPreset {
  if (isOwn(query.player, query.exactPlayer, self)) return "own";
  if (isRecentBound(query.after)) return "lastYear";
  return "newest";
}
