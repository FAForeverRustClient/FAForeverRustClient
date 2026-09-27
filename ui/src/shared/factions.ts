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
 * The order the four playable factions are drawn in, wherever a list of them
 * is shown: UEF, Cybran, Aeon, Seraphim.
 *
 * Not the numeric order, and not alphabetical. It is the order the rest of FAF
 * lists them in, and a player reading a row of emblems is matching a shape
 * against a habit rather than reading a list, so the habit is what the row has
 * to agree with. The numbering above stays what it is: it is the game's, and
 * changing it would change every glyph.
 */
export const FACTION_DISPLAY_ORDER: readonly number[] = [1, 3, 2, 4];

/**
 * The same order, applied to a list of faction *names* off the wire.
 *
 * A faction this client does not recognise keeps its place at the end rather
 * than being dropped or sorted to the front: see [`factionIdFromName`].
 */
export function orderFactionNames(names: readonly string[]): string[] {
  const rank = (name: string) => {
    const id = factionIdFromName(name);
    const index = id === null ? -1 : FACTION_DISPLAY_ORDER.indexOf(id);
    return index < 0 ? FACTION_DISPLAY_ORDER.length : index;
  };
  return [...names].sort((left, right) => rank(left) - rank(right));
}

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
