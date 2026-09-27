// The two rules the map vault applies to a page after it arrives.
//
// Both exist because the API cannot answer them for this tab. Installed vs
// available is local knowledge the server has never had. Withdrawn versions
// it does know about, and is asked about (`latestVersion.hidden=='false'`,
// the same clause the Java client sends), but a withdrawn map came back
// through that filter anyway, so the rule is applied to what arrived rather
// than trusted to the query. The favourites preset needs it for a third
// reason: that preset answers from the catalogue index, which nothing
// filters, and a map can be withdrawn long after it was starred.

import type { VaultMap } from "../../ipc/bindings";
import { mapInstalled } from "../../shared/mapPresentation";

export type InstallFilter = "all" | "installed" | "available";

export interface VaultResultRules {
  /** Keep versions the author withdrew from the vault. */
  showHidden: boolean;
  /**
   * "My maps" keeps them regardless: an author is the one person who still
   * needs to see what they withdrew, and neither reference client can show
   * them.
   */
  ownMaps: boolean;
  installFilter: InstallFilter;
  /** Lower-cased installed folder names. */
  installedFolders: Set<string>;
}

export function visibleVaultMaps(source: VaultMap[], rules: VaultResultRules): VaultMap[] {
  const visible = rules.showHidden || rules.ownMaps
    ? source
    : source.filter((map) => !map.hidden);
  if (rules.installFilter === "all") return visible;
  return visible.filter(
    (map) => mapInstalled(map, rules.installedFolders) === (rules.installFilter === "installed"),
  );
}
