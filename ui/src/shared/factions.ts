export const FACTION_NAMES: Readonly<Record<number, string>> = {
  1: "UEF",
  2: "Aeon",
  3: "Cybran",
  4: "Seraphim",
  5: "Random", // proper noun in the picker; the translated label is factions.random
};

export const FACTION_COLORS: Readonly<Record<number, string>> = {
  1: "var(--color-faction-uef)",
  2: "var(--color-faction-aeon)",
  3: "var(--color-faction-cybran)",
  4: "var(--color-faction-seraphim)",
  5: "var(--color-muted)",
};

export const FACTION_OPTIONS = Object.entries(FACTION_NAMES).map(([value, label]) => ({
  value,
  label,
}));

/**
 * The id behind a faction *name*, for the places that are handed one.
 *
 * The lobby's party message carries factions as the words a player picked
 * ("uef", "aeon"), while every glyph in this client is keyed by the game's own
 * numbering. Case is ignored because the wire is lowercase and the picker is
 * not, and an unknown word answers `null` rather than a number: a faction this
 * client has never heard of should print as whatever it called itself, not as
 * the wrong emblem.
 */
export function factionIdFromName(name: string): number | null {
  const wanted = name.trim().toLocaleLowerCase();
  if (!wanted) return null;
  const found = Object.entries(FACTION_NAMES).find(
    ([, label]) => label.toLocaleLowerCase() === wanted,
  );
  return found ? Number(found[0]) : null;
}
