// The order of the players inside each roster group (#513).

import type { ChatUser, PlayerProfile } from "../../../ipc/bindings";
import { displayedRating, LEADERBOARD_ORDER } from "../../../shared/playerRatings";

/**
 * `"name"`: the order the chat server lists people in. Anything else is the
 * technical name of a leaderboard (`LEADERBOARD_ORDER`).
 */
export type RosterSort = string;

export const ROSTER_SORTS: readonly RosterSort[] = ["name", ...LEADERBOARD_ORDER];

export function isRosterSort(value: unknown): value is RosterSort {
  return typeof value === "string" && ROSTER_SORTS.includes(value);
}

/**
 * `users` by their rating on `sort`, highest first, or as they came for
 * `name`.
 *
 * Inside a group, never across them: friends stay with friends. A player who
 * has never played that board, or an IRC-only nickname, has no rating there,
 * and goes after everybody who has one, in the order they came. Same ratings
 * keep their order too, so the list does not reshuffle on every update.
 */
export function sortRoster(
  users: readonly ChatUser[],
  sort: RosterSort,
  profileOf: (nickname: string) => PlayerProfile | undefined,
): ChatUser[] {
  if (sort === "name") return [...users];
  const rated = users.map((user, index) => ({
    user,
    index,
    rating: displayedRating(profileOf(user.name), sort),
  }));
  rated.sort((left, right) => {
    if (left.rating === null || right.rating === null) {
      if (left.rating !== right.rating) return left.rating === null ? 1 : -1;
      return left.index - right.index;
    }
    return right.rating - left.rating || left.index - right.index;
  });
  return rated.map((entry) => entry.user);
}
