// Which remote map thumbnails have already answered "no image".
//
// A co-op mission or a generated map has no art on the content server at all -
// the API builds a `thumbnailUrl` out of the folder name without checking one
// exists - so a tile for one walks its entire candidate list, rendering a
// broken `<img>` at each step before `onError` moves it along. Doing that walk
// once is fine. Doing it again on every mount is what made the icons beside
// the chat roster blink every time someone came back to the tab: leaving the
// tab unmounts the list, and the walk started from zero.
//
// Session-scoped and thumbnails only. The worst a wrongly remembered miss
// costs is a placeholder icon until the client restarts, which is why a
// transient network failure is an acceptable thing to remember here.

const missing = new Set<string>();

export function markThumbnailMissing(url: string): void {
  missing.add(url);
}

/**
 * The index of the first candidate not already known to be missing.
 *
 * Returns `candidates.length` when every one of them has failed, which is the
 * caller's signal to fall back to local art or a placeholder - immediately, on
 * a remount, rather than after replaying the misses.
 */
export function firstLiveCandidate(candidates: readonly string[]): number {
  let index = 0;
  while (index < candidates.length && missing.has(candidates[index])) index += 1;
  return index;
}

/** Test seam: the module-level cache would otherwise leak between cases. */
export function resetMissingThumbnails(): void {
  missing.clear();
}
