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
