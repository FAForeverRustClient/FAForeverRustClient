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
export interface ModVaultFocus {
  search: string;
  /**
   * Where the search looks: the name, which is what every button that knows
   * the mod's name wants, or also the description and the uid, which is how
   * a `faf://mod/<uid>` link finds its mod.
   */
  scope: "name" | "description";
}

let requested: ModVaultFocus | null = null;

/** Ask the mods tab to open on this mod. Call before navigating to it. */
export function requestModVaultFocus(search: string, scope: ModVaultFocus["scope"] = "name") {
  const trimmed = search.trim();
  requested = trimmed ? { search: trimmed, scope } : null;
}

/**
 * Whether a request is waiting, without taking it: the tab uses this to land
 * on the vault before the vault view, which takes it, has mounted.
 */
export function hasModVaultFocus(): boolean {
  return Boolean(requested);
}

/** Take the pending request, if any. Returns it once and forgets it. */
export function takeModVaultFocus(): ModVaultFocus | null {
  const pending = requested;
  requested = null;
  return pending;
}
