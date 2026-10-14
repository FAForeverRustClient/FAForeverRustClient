/**
 * A map the user asked to see in the map vault, handed to the Maps tab as
 * they arrive on it: the twin of `modVaultFocus`, for the same reason. The
 * vault view dispatches its own search for its filter state as it mounts, so
 * what has to cross the tab boundary is the filter (the map's name) and the
 * map to select in the results (its folder), not a search result.
 *
 * One value, consumed once: the tab reads it while mounting and clears it, so
 * coming back to the Maps tab later does not repeat somebody's old jump.
 */
export interface MapVaultFocus {
  /** What to search the vault for: the map's display name. */
  name: string;
  /** The version to select among the results, when the caller knows it. */
  folderName: string;
}

let requested: MapVaultFocus | null = null;

/** Ask the Maps tab to open on this map. Call before navigating to it. */
export function requestMapVaultFocus(focus: MapVaultFocus) {
  const name = focus.name.trim();
  requested = name ? { name, folderName: focus.folderName.trim() } : null;
}

/**
 * Whether a request is waiting, without taking it: the tab uses this to land
 * on the vault before the vault view, which takes it, has mounted.
 */
export function hasMapVaultFocus(): boolean {
  return requested !== null;
}

/** Take the pending request, if any. Returns it once and forgets it. */
export function takeMapVaultFocus(): MapVaultFocus | null {
  const pending = requested;
  requested = null;
  return pending;
}
