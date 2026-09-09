/**
 * Is the vault's copy of a mod newer than the installed one?
 *
 * The check used to be `installed.version !== vault.version`, a string
 * comparison between two numbers that are written down in two different
 * places. `mod_info.lua` carries whatever the author typed, and the API stores
 * the version as a number, so "3.0" on disk against 3 from the vault reads as
 * an update that does not exist. That is what made the "N updates available"
 * count disagree with the mods it then listed.
 *
 * Two versions that both parse as numbers are compared as numbers, which is
 * how the files that wrote them read them too: `version = 1.10` in
 * `mod_info.lua` is a Lua number, and Lua reads that as 1.1, not as a tenth
 * minor release. Anything else falls back to the text with a numeric-aware
 * collation, so `v1.9` still sorts before `v1.10`.
 *
 * Either way a difference is only an update when the vault's version is
 * *ahead* of the installed one: a hand-built copy that runs in front of the
 * vault is not something to offer to overwrite.
 *
 * An empty version on either side answers "no": the vault has not said, or the
 * folder has no readable `mod_info.lua`, and neither is evidence of anything.
 */
export function modUpdateAvailable(installedVersion: string, vaultVersion: string): boolean {
  const installed = installedVersion.trim();
  const vault = vaultVersion.trim();
  if (!installed || !vault) return false;
  if (installed === vault) return false;

  const installedNumber = Number(installed);
  const vaultNumber = Number(vault);
  if (Number.isFinite(installedNumber) && Number.isFinite(vaultNumber)) {
    return vaultNumber > installedNumber;
  }

  return vault.localeCompare(installed, undefined, { numeric: true, sensitivity: "accent" }) > 0;
}
