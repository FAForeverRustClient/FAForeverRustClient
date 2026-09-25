// Which installed mod a vault entry is, and which vault entry an installed mod
// belongs to.
//
// Every version of a mod on FAF carries a uid of its own, and the vault lists a
// mod under its latest version. Matching the two sides by uid alone therefore
// only ever recognised a mod whose newest version was the one installed. An
// older copy was a stranger to its own vault entry: the card offered "Install"
// rather than "Update", the install then refused the folder that was already
// there ("is already installed"), and the Installed tab never saw an update
// either. So the uid decides when it matches, and otherwise the mod's name and
// author do, as long as they point at exactly one mod on the other side.

import type { InstalledMod, VaultMod } from "../../ipc/bindings";

function identity(name: string, author: string): string {
  return `${name.trim().toLocaleLowerCase()}\u0000${author.trim().toLocaleLowerCase()}`;
}

/**
 * Index `items` by `key`, leaving out every key that more than one item has:
 * two mods of the same name by the same author are two mods, and picking one
 * of them would update the wrong one.
 */
function uniqueBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const unique = new Map<string, T>();
  const repeated = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (repeated.has(value)) continue;
    if (unique.has(value)) {
      unique.delete(value);
      repeated.add(value);
    } else {
      unique.set(value, item);
    }
  }
  return unique;
}

export interface ModCounterparts {
  /** The installed copy of a vault entry, whichever version it is. */
  installedFor: (mod: VaultMod) => InstalledMod | undefined;
  /** The vault entry an installed mod is a version of. */
  vaultFor: (mod: InstalledMod) => VaultMod | undefined;
}

export function modCounterparts(
  installed: readonly InstalledMod[],
  vault: readonly VaultMod[],
): ModCounterparts {
  const installedByUid = new Map(installed.map((mod) => [mod.uid, mod]));
  const vaultByUid = new Map(vault.map((mod) => [mod.uid, mod]));
  const installedByIdentity = uniqueBy(installed, (mod) => identity(mod.displayName, mod.author));
  const vaultByIdentity = uniqueBy(vault, (mod) => identity(mod.displayName, mod.author));
  // A name and author only stand for a mod when they are unique on *both*
  // sides. Two vault mods sharing them would otherwise both claim the one
  // installed copy, and updating from the wrong card would replace it with a
  // different mod.
  const paired = (key: string) => installedByIdentity.has(key) && vaultByIdentity.has(key);
  return {
    installedFor: (mod) => {
      const exact = installedByUid.get(mod.uid);
      if (exact) return exact;
      const key = identity(mod.displayName, mod.author);
      return paired(key) ? installedByIdentity.get(key) : undefined;
    },
    vaultFor: (mod) => {
      const exact = vaultByUid.get(mod.uid);
      if (exact) return exact;
      const key = identity(mod.displayName, mod.author);
      return paired(key) ? vaultByIdentity.get(key) : undefined;
    },
  };
}
