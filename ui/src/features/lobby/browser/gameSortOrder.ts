// The order the game lists are in: which column, and which way round.
//
// Split out of `LobbyView` when the column headers became the sort control,
// because two places now need the same answer and they must not disagree: the
// list sorts by it, and the arrow drawn in the header claims what it did.
//
// The stored flag is `sortReversed`, not a direction, and that is the whole
// trick. Every column has an order somebody means by clicking it: the most
// players first, the highest rating first, the newest lobby first, maps and
// hosts and titles from A to Z. Those are not the same direction, so one
// stored "descending" would have been wrong for half the columns, and a
// settings file written before any of this existed reads back as false, which
// is exactly the order the list has always been in.

import type { CustomGameSort } from "../../../ipc/bindings";
import type { Game } from "../../../ipc/bindings";

/**
 * The columns whose natural order runs high to low.
 *
 * Age is not one of them: its natural order is the newest lobby first, which
 * is the *smallest* age, so the column reads as ascending even though the
 * timestamp behind it does not. The reader sees the ages, so the arrow follows
 * the ages.
 */
const NATURALLY_DESCENDING: readonly CustomGameSort[] = ["players", "rating"];

/** Which way the arrow in the header points, and what `aria-sort` says. */
export function sortsDescending(sort: CustomGameSort, reversed: boolean): boolean {
  return NATURALLY_DESCENDING.includes(sort) !== reversed;
}

/**
 * One column's natural order: the comparison this list has always made.
 *
 * Exported for the test; the list itself calls [`compareGames`], which is this
 * with the reversal applied.
 */
export function compareNaturally(sort: CustomGameSort, left: Game, right: Game): number {
  switch (sort) {
    case "players":
      return right.players - left.players;
    case "rating":
      return right.averageRating - left.averageRating;
    case "map":
      return left.map.localeCompare(right.map);
    case "host":
      return left.host.localeCompare(right.host);
    case "age":
      // Newest first, so the freshest lobbies are at the top of a list nobody
      // scrolls. `hostedAt` is RFC 3339, which sorts correctly as text.
      return (right.hostedAt ?? "").localeCompare(left.hostedAt ?? "");
    case "title":
      // The lobby's own name, which is the list's first column and the one
      // thing it could not be ordered by until the headers became controls.
      return left.title.localeCompare(right.title);
  }
}

export function compareGames(
  sort: CustomGameSort,
  reversed: boolean,
  left: Game,
  right: Game,
): number {
  return reversed ? -compareNaturally(sort, left, right) : compareNaturally(sort, left, right);
}
