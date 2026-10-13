// Which players the roster shows, and in what order inside each group (#513).

import type { ChatUser, PlayerProfile } from "../../../ipc/bindings";
import { displayedRating, LEADERBOARD_ORDER } from "../../../shared/playerRatings";

/** The boards a player can be filtered and ordered by. */
export const ROSTER_BOARDS: readonly string[] = LEADERBOARD_ORDER;

export interface RosterView {
  /** The leaderboard both the order and the range read. */
  board: string;
  /** `name`: the order the chat server lists people in. */
  order: "name" | "rating";
  /** The rating range on `board`; `null` is an open end. */
  min: number | null;
  max: number | null;
}

export const DEFAULT_ROSTER_VIEW: RosterView = { board: "global", order: "name", min: null, max: null };

export function hasRatingRange(view: RosterView): boolean {
  return view.min !== null || view.max !== null;
}

/** Whether anything differs from the plain list, which the button shows. */
export function isRosterViewActive(view: RosterView): boolean {
  return view.order !== "name" || hasRatingRange(view);
}

/** Whether rows carry their rating on `board`: when it decides anything. */
export function showsRating(view: RosterView): boolean {
  return isRosterViewActive(view);
}

/** A remembered view from an older or foreign build is replaced, not trusted. */
export function readRosterView(value: Partial<RosterView>): RosterView {
  const board = typeof value.board === "string" && ROSTER_BOARDS.includes(value.board) ? value.board : "global";
  const order = value.order === "rating" ? "rating" : "name";
  const bound = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { board, order, min: bound(value.min), max: bound(value.max) };
}

/**
 * `users` filtered to the rating range and ordered as `view` says.
 *
 * Inside a group, never across them: friends stay with friends. A player with
 * no rating on the board, or an IRC-only nickname, has nothing to compare: a
 * range leaves them out, and an order by rating puts them last, in the order
 * they came. Same ratings keep their order too, so the list does not
 * reshuffle on every update. `keep` names who stays whatever the range says
 * (yourself).
 */
export function shapeRoster(
  users: readonly ChatUser[],
  view: RosterView,
  profileOf: (nickname: string) => PlayerProfile | undefined,
  keep: (user: ChatUser) => boolean = () => false,
): ChatUser[] {
  if (!isRosterViewActive(view)) return [...users];
  const rated = users.map((user, index) => ({
    user,
    index,
    rating: displayedRating(profileOf(user.name), view.board),
  }));
  const inRange = hasRatingRange(view)
    ? rated.filter(({ user, rating }) =>
      keep(user)
      || (rating !== null
        && (view.min === null || rating >= view.min)
        && (view.max === null || rating <= view.max)))
    : rated;
  if (view.order === "rating") {
    inRange.sort((left, right) => {
      if (left.rating === null || right.rating === null) {
        if (left.rating !== right.rating) return left.rating === null ? 1 : -1;
        return left.index - right.index;
      }
      return right.rating - left.rating || left.index - right.index;
    });
  }
  return inRange.map((entry) => entry.user);
}
