// Asks the vault for maps by display name, for pages that name maps the way a
// person typed them and cannot afford the whole catalogue: a tournament's map
// pool, whose sizes the organiser often left out. The answer joins
// `maps.vault`, where `matchVaultMap` already looks.
//
// The folder twin is `useVaultFolderLookup`; this one takes a page's whole
// list at once, since the names arrive together with the event.

import { useEffect } from "react";
import { ipc } from "../../ipc/client";
import { mapKey } from "../rules/tourneyRules";

/// Names already asked about, for the whole session, by their folded key. A
/// name the vault does not know stays unknown; asking again on every visit to
/// the page would be a request each time for nothing.
const requested = new Set<string>();

/** Test seam: the module-level guard would otherwise leak between cases. */
export function resetVaultNameLookups(): void {
  requested.clear();
}

/** Look the named maps up in the vault once each, sent as one request. */
export function useVaultNameLookup(displayNames: string[]): void {
  // Joined so the effect runs when the set of names changes, not whenever the
  // caller builds a fresh array with the same names in it.
  const joined = displayNames.join("\n");
  useEffect(() => {
    const fresh = joined
      .split("\n")
      .filter((name) => {
        const key = mapKey(name);
        if (key === "" || requested.has(key)) return false;
        requested.add(key);
        return true;
      });
    if (fresh.length === 0) return;
    ipc.send({ kind: "Maps", command: { type: "resolveVaultNames", payload: { displayNames: fresh } } });
  }, [joined]);
}
