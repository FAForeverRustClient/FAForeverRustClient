// The hosts whose games the browser always shows (#492): the exception to
// every hide switch and filter rule, so somebody who hides modded and unranked
// games still sees what a particular host has opened. The search box is not an
// exception: a search is what the player is looking for right now.

/** The stored logins, ready to look a host up in whatever case it arrives. */
export function hostWhitelist(hosts: readonly string[]): ReadonlySet<string> {
  return new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
}

export function isWhitelistedHost(host: string, whitelist: ReadonlySet<string>): boolean {
  return whitelist.size > 0 && whitelist.has(host.trim().toLowerCase());
}

/**
 * Whether a game stays in the list: a whitelisted host's always does, any
 * other game only when it passes every filter.
 */
export function shownDespiteFilters(
  host: string,
  whitelist: ReadonlySet<string>,
  passesFilters: () => boolean,
): boolean {
  return isWhitelistedHost(host, whitelist) || passesFilters();
}
