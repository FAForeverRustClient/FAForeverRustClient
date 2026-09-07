// What a player is actually looking for is a build order for 1v1.
//
// Not a build order by Sladow-Noob. An earlier version of this file shelved the
// library by whose work an entry was, which put twenty-one build orders under
// one name and seven identical ones under another, and asked the reader to know
// the authors before the shelf meant anything. Who wrote it is a fact about the
// entry, not a reason to file it: it belongs on the card and in the detail.
//
// So the shelves are game modes. That is the sentence a player says out loud
// before they open this tab, the tabs above already answer "what kind", and the
// two together are the whole question: a build order, for 1v1.
//
// Nothing here is a rule the domain shares, so unlike `shared/trainingRules` it
// has no Rust twin: grouping is how this one view arranges what the filter
// returned, and it runs on every keystroke because the groups change as the
// filter narrows.

import type { MessageKey } from "../../i18n";
import type { TrainingProfile, TrainingResource } from "../../ipc/bindings";
import { normaliseMap } from "../../shared/trainingRules";
import { kindLabel } from "./trainingPresentation";

/**
 * How the reader asked for the shelves to be arranged.
 *
 * Ordering is behaviour rather than structure, which is the line the design
 * philosophy draws around what may be configurable: where the shelves are is
 * fixed, which one comes first is the reader's business. An implicit order
 * nobody chose was the previous version's weakest point, because the one thing
 * a reader could not do with it was disagree.
 */
export type LibrarySort = "forYou" | "recent" | "alpha";

export const LIBRARY_SORTS: LibrarySort[] = ["forYou", "recent", "alpha"];

/**
 * How an order is worded. Lives here rather than in `trainingPresentation`
 * because the type does, and the two modules would otherwise import each other.
 */
export function sortLabel(sort: LibrarySort): MessageKey {
  return `training.library.sort.${sort}`;
}

export interface Collection {
  /** The mode, and the heading. Empty for the bucket of entries naming none. */
  key: string;
  entries: TrainingResource[];
  /** True for the bucket that holds whatever names no mode. */
  isRemainder?: boolean;
}

/**
 * The lobby type, not a shape of game.
 *
 * Every entry in the catalogue that says `custom` also says `4v4`, because
 * `custom` answers "where is it hosted" and the other one answers "what is it".
 * Shelving by the first mode an entry lists would file twenty team guides under
 * a word that tells a player nothing about whether it is for them.
 */
const LOBBY_TYPES = ["custom"];

/**
 * The mode an entry is shelved under.
 *
 * One shelf per entry rather than one per mode it names: a card that appeared
 * under both "1v1" and "4v4" would be the same card twice on one screen, and
 * the mode filter above already finds it under either.
 */
function shelfMode(resource: TrainingResource): string {
  const modes = resource.gameModes.map((mode) => mode.trim()).filter(Boolean);
  return modes.find((mode) => !LOBBY_TYPES.includes(mode.toLowerCase())) ?? modes[0] ?? "";
}

/** Whether this entry is on ground the player has been playing. */
function onMyMaps(resource: TrainingResource, maps: string[]): boolean {
  return resource.maps.some((map) => {
    const mine = normaliseMap(map);
    return mine !== "" && maps.some((played) => played.includes(mine) || mine.includes(played));
  });
}

/**
 * The newest date anything on the shelf carries.
 *
 * The catalogue writes dates as ISO days, so this compares as text and needs no
 * parser. An entry with no date sorts as the empty string, which is older than
 * anything, and that is the right answer: it is a row nobody has dated.
 */
function newest(entries: TrainingResource[]): string {
  return entries.reduce(
    (latest, entry) => (entry.updatedAt > latest ? entry.updatedAt : latest),
    "",
  );
}

/**
 * The order inside a shelf.
 *
 * Under "for you", what is on the maps this player has been playing rises to
 * the front and everything else keeps catalogue order. That order is the one
 * its authors put their work in, and because the sort is stable a series stays
 * a series: its parts all score the same and so never overtake each other.
 */
function orderEntries(
  entries: TrainingResource[],
  sort: LibrarySort,
  profile: TrainingProfile,
): TrainingResource[] {
  if (sort === "alpha") return [...entries].sort((a, b) => a.title.localeCompare(b.title));
  if (sort === "recent") return [...entries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const maps = profile.maps.map(normaliseMap).filter(Boolean);
  if (maps.length === 0) return entries;
  return [...entries].sort(
    (a, b) => Number(onMyMaps(b, maps)) - Number(onMyMaps(a, maps)),
  );
}

/**
 * How two shelves compare, under each of the three orders.
 *
 * Every one of them ends in a tiebreak that cannot tie, so two loads that
 * learned nothing new put the library in the same order. A shelf that moved on
 * a refresh would cost the reader the one thing shelves are for.
 */
function comparatorFor(
  sort: LibrarySort,
  profile: TrainingProfile,
): (a: Collection, b: Collection) => number {
  const byName = (a: Collection, b: Collection) => a.key.localeCompare(b.key);
  if (sort === "alpha") return byName;
  if (sort === "recent") {
    return (a, b) => newest(b.entries).localeCompare(newest(a.entries)) || byName(a, b);
  }
  // For you: the modes this player has actually been playing, then the fuller
  // shelf, which is the closest thing to authority the catalogue carries.
  const mine = profile.gameModes.map((mode) => mode.toLowerCase());
  const plays = (collection: Collection) => Number(mine.includes(collection.key.toLowerCase()));
  return (a, b) =>
    plays(b) - plays(a) || b.entries.length - a.entries.length || byName(a, b);
}

/**
 * The filtered catalogue, on shelves.
 *
 * Whatever names no mode follows in one group at the end rather than being
 * scattered between the headings, whichever way the rest is sorted: it is a
 * bucket, not a shelf, and a bucket that moved around would be mistaken for one.
 */
export function collectionsOf(
  resources: TrainingResource[],
  profile: TrainingProfile,
  sort: LibrarySort = "forYou",
): Collection[] {
  const shelves = new Map<string, TrainingResource[]>();
  const loose: TrainingResource[] = [];

  for (const resource of resources) {
    const mode = shelfMode(resource);
    if (mode === "") {
      loose.push(resource);
      continue;
    }
    const shelf = shelves.get(mode);
    if (shelf) shelf.push(resource);
    else shelves.set(mode, [resource]);
  }

  const collections: Collection[] = [...shelves].map(([key, entries]) => ({
    key,
    entries: orderEntries(entries, sort, profile),
  }));
  collections.sort(comparatorFor(sort, profile));

  if (loose.length > 0) {
    collections.push({
      key: "",
      entries: orderEntries(loose, sort, profile),
      isRemainder: true,
    });
  }
  return collections;
}

/** Re-export so the view can label a kind without importing two modules. */
export { kindLabel };
