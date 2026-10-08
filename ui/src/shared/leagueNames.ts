// What a league division, a tier and a season are called.
//
// The Rust side used to write these ("Bronze II", "Season 12") into the IPC
// payloads, in English, where no translation could reach them. It now sends
// identifiers: the division's name key as the API has it (`bronze`,
// `grandmaster`), the subdivision's Roman numeral, and the season's number.
// Naming them is the catalogue's job, the way the Java client resolves
// `leagues.divisionName.<key>` from its bundle.

import { t, type MessageKey } from "../i18n";

const DIVISION_KEYS: Record<string, MessageKey> = {
  bronze: "leagues.division.bronze",
  silver: "leagues.division.silver",
  gold: "leagues.division.gold",
  diamond: "leagues.division.diamond",
  master: "leagues.division.master",
  grandmaster: "leagues.division.grandmaster",
};

/**
 * A division's name: "Bronze", "Silber", ...
 *
 * A key this client has never seen is shown capitalised rather than hidden:
 * FAF can add a division without asking, and its key is the best name there is
 * until the catalogue learns it. An empty key is a placement the API sent
 * without its division.
 */
export function divisionLabel(division: string | null | undefined): string {
  const key = (division ?? "").trim().toLowerCase();
  if (!key) return t("leagues.division.none");
  const message = DIVISION_KEYS[key];
  if (message) return t(message);
  return key.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * A tier's name, division then subdivision: "Bronze II".
 *
 * The subdivision is a Roman numeral and reads the same in every language, so
 * only the division is translated; the order of the two is the catalogue's.
 */
export function tierLabel(
  division: string | null | undefined,
  subdivision: string | null | undefined,
): string {
  const numeral = (subdivision ?? "").trim();
  const name = divisionLabel(division);
  return numeral ? t("leagues.tier", { division: name, subdivision: numeral }) : name;
}

/** What a season is called: "Season 12". */
export function seasonLabel(seasonNumber: number): string {
  return t("leagues.season", { number: seasonNumber });
}

/**
 * Whether a division is the top one, which has a single subdivision and is
 * labelled by its abbreviation in the distribution chart instead.
 */
export function isGrandmaster(division: string | null | undefined): boolean {
  return (division ?? "").trim().toLowerCase() === "grandmaster";
}

/**
 * A placement's tier, or `null` for none: no placement at all, or one the API
 * sent without its division. The callers say "Unplaced" for both, which is
 * what an empty division used to mean when it arrived as an empty label.
 */
export function placementLabel(
  placement: { division: string; subdivision: string } | null | undefined,
): string | null {
  if (!placement || !placement.division.trim()) return null;
  return tierLabel(placement.division, placement.subdivision);
}
