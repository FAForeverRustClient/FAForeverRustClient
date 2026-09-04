/**
 * A mod the user asked to inspect, handed to the mods tab as they arrive on it.
 *
 * The replays tab takes the same kind of request as a domain command, because
 * its results are what a `searchVault` command produced. That does not work
 * here: `ModsView` dispatches its own `searchVault` for its filter state as
 * soon as it mounts, so a search sent from another tab is overwritten before it
 * is ever seen. What has to cross the tab boundary is therefore the *filter*,
 * not the result, and the filter is local state inside `ModsView`.
 *
 * One value, consumed once: the tab reads it while mounting and clears it, so
 * coming back to the mods tab later does not repeat somebody's old search.
 */
let requested: string | null = null;

/** Ask the mods tab to open on this mod. Call before navigating to it. */
export function requestModVaultFocus(modName: string) {
  requested = modName.trim();
}

/** Take the pending request, if any. Returns it once and forgets it. */
export function takeModVaultFocus(): string | null {
  const pending = requested;
  requested = null;
  return pending || null;
}
