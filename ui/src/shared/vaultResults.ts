// What the map and mod vaults decide about a page once it is on screen, and
// the pieces both need to answer a vault query without the server.
//
// Two problems share this file. The first is paging: both vaults page on the
// server, then apply rules the API cannot answer (installed, not installed,
// update available) to the page that came back. A page those rules emptied is
// not a search that found nothing, and treating it as one hid the pager and
// said "no matches" while later pages still held some. The second is the
// favourites preset, which the server has never heard of and which is answered
// from the catalogue index in memory: it has to honour the same search, filter
// and sort contract the server query does, or the controls above it lie.

/**
 * What the results area should say about the page on screen.
 *
 * - `results`: something to show.
 * - `waiting`: nothing yet, and the search behind it has not answered.
 * - `filteredOnPage`: the server sent this page, and the client-side rules
 *   removed all of it. Other pages may still have matches.
 * - `emptyPage`: the server sent nothing for this page but reports more than
 *   one page, so the search itself is not empty.
 * - `noMatch`: the whole search has nothing to show.
 */
export type VaultPageKind = "results" | "waiting" | "filteredOnPage" | "emptyPage" | "noMatch";

export interface VaultPageOutcome {
  kind: VaultPageKind;
  /** Whether the pager belongs on screen, whatever this one page holds. */
  showPager: boolean;
  /** The page to point the reader at when this one has nothing, or null. */
  nextPage: number | null;
}

export interface VaultPageFacts {
  /** The search behind this page has answered, or the list is local. */
  settled: boolean;
  /** What the source handed over for this page, before client-side rules. */
  received: number;
  /** What is left to show after them. */
  shown: number;
  currentPage: number;
  totalPages: number;
}

export function vaultPageOutcome(facts: VaultPageFacts): VaultPageOutcome {
  const showPager = facts.totalPages > 1;
  const nextPage = facts.currentPage < facts.totalPages ? facts.currentPage + 1 : null;
  const outcome = (kind: VaultPageKind): VaultPageOutcome => ({
    kind,
    showPager,
    nextPage: kind === "results" ? null : nextPage,
  });
  if (facts.shown > 0) return outcome("results");
  // Before `settled`, on purpose: stepping to the next page from one the
  // filter emptied keeps the note and the pager up while that page loads,
  // instead of blanking the area and bringing it back a moment later.
  if (showPager && facts.received > 0) return outcome("filteredOnPage");
  if (!facts.settled) return outcome("waiting");
  // One page is the whole search, so a filter that emptied it has been
  // checked against every result there is, and "no matches" is then true.
  return outcome(showPager ? "emptyPage" : "noMatch");
}

/**
 * Text the way the vault query sends it, for matching on the client.
 *
 * The domain strips the characters that would break out of a quoted RSQL
 * argument before wrapping the text in a glob (`escape` in
 * `crates/faf-domain/src/protocol/vault_query.rs`). Doing the same here keeps
 * a local answer from disagreeing with the server's over a stray quote.
 * Lower-cased, because the API's `==` glob does not care about case.
 */
export function vaultSearchText(value: string): string {
  return value.replace(/["\\*;(),']/g, "").toLocaleLowerCase();
}

/** The server's `field=="*text*"`: `text` already passed through `vaultSearchText`. */
export function matchesVaultGlob(field: string | null | undefined, text: string): boolean {
  return (field ?? "").toLocaleLowerCase().includes(text);
}

/**
 * The API's "highest rated" order, rebuilt from what a vault record carries.
 *
 * The server sorts on `reviewsSummary.lowerBound`, a Wilson score lower bound,
 * so that a 5.0 from one review does not outrank a 4.8 from two hundred. The
 * records keep only the average and the count, so the bound is reconstructed
 * from them: each review counts as `(score - 1) / 4` positive and the rest
 * negative, which is the usual way a five-star score is fed to Wilson. It
 * orders the same way the server does in every case that matters to a reader
 * (more reviews at the same average rank higher), though it is not guaranteed
 * to equal the server's stored value. Unreviewed records sort last.
 */
export function ratingLowerBound(ratingTenths: number, reviews: number): number {
  if (reviews <= 0) return -1;
  const average = Math.min(5, Math.max(1, ratingTenths / 10));
  const positive = (reviews * (average - 1)) / 4;
  const z = 1.96;
  const share = positive / reviews;
  const spread = z * Math.sqrt((share * (1 - share) + (z * z) / (4 * reviews)) / reviews);
  return (share + (z * z) / (2 * reviews) - spread) / (1 + (z * z) / reviews);
}

/** A page of a list that is already whole in memory, with honest counts. */
export function localPage<T>(items: readonly T[], page: number, pageSize: number): {
  items: T[];
  currentPage: number;
  totalPages: number;
} {
  const size = Math.max(1, pageSize);
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  return {
    items: items.slice((currentPage - 1) * size, currentPage * size),
    currentPage,
    totalPages,
  };
}
