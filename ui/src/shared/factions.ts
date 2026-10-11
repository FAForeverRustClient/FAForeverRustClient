import { t, type MessageKey } from "../i18n";

/**
 * The game's own faction words, keyed by its faction id.
 *
 * These are identifiers, not labels: they are what the wire and the stored
 * preferences carry ("uef", "Seraphim"), and what [`factionIdFromName`]
 * matches against. Anything shown to a reader goes through [`factionLabel`].
 */
export const FACTION_NAMES: Readonly<Record<number, string>> = {
  1: "UEF",
  2: "Aeon",
  3: "Cybran",
  4: "Seraphim",
  5: "Random", // wire word only; the translated label is factions.random
};

const FACTION_LABEL_KEYS: Readonly<Record<number, MessageKey>> = {
  1: "factions.uef",
  2: "factions.aeon",
  3: "factions.cybran",
  4: "factions.seraphim",
  5: "factions.random",
};

const GALACTIC_WAR_FACTION_LABEL_KEYS: Readonly<
  Partial<Record<number, MessageKey>>
> = {
  1: "lobby.galacticWar.faction.name.uef",
  2: "lobby.galacticWar.faction.name.aeon",
  3: "lobby.galacticWar.faction.name.cybran",
  4: "lobby.galacticWar.faction.name.seraphim",
};

const FACTION_ID_BY_LONG_NAME: Readonly<Record<string, number>> = {
  "united earth federation": 1,
  "aeon illuminate": 2,
  "cybran nation": 3,
  "seraphim army": 4,
};

export const FACTION_COLORS: Readonly<Record<number, string>> = {
  1: "var(--color-faction-uef)",
  2: "var(--color-faction-aeon)",
  3: "var(--color-faction-cybran)",
  4: "var(--color-faction-seraphim)",
  5: "var(--color-muted)",
};

/** The faction's name in the reader's language, by the game's faction id. */
export function factionLabel(id: number): string {
  const key = FACTION_LABEL_KEYS[id] as MessageKey | undefined;
  return key ? t(key) : t("factions.unknown");
}

/**
 * The reader's name for a faction handed over as a wire word ("uef").
 *
 * A word this client does not know is shown as it arrived rather than as
 * "Unknown faction": it is still the best name anyone has for it.
 */
export function factionLabelFromName(name: string): string {
  const id = factionIdFromName(name);
  return id === null ? name : factionLabel(id);
}

/** The full Galactic War faction name, with the server name as fallback. */
export function galacticWarFactionLabel(name: string, fallback: string): string {
  const id = factionIdFromName(name);
  const key = id === null ? undefined : GALACTIC_WAR_FACTION_LABEL_KEYS[id];
  return key ? t(key) : fallback;
}

/** Every faction, Random included, as select options keyed by faction id. */
export function factionOptions(): Array<{ value: string; label: string }> {
  return Object.keys(FACTION_NAMES).map((value) => ({
    value,
    label: factionLabel(Number(value)),
  }));
}

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
  return found ? Number(found[0]) : FACTION_ID_BY_LONG_NAME[wanted] ?? null;
}
