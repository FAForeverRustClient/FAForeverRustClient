import { t } from "../i18n";
import type { MessageKey } from "../i18n/catalog/en";

/**
 * The name a featured mod is known by, from the technical name the server
 * sends.
 *
 * The lobby, the chat cards and the browser all receive `faf`, `fafbeta`,
 * `fafdevelop` and friends: the id, not something anybody calls it. The Host
 * Game dialog has spelled these out since it was written, so the names live in
 * the catalogue already and this reads the same entries rather than inventing a
 * second set that could drift from them.
 *
 * Anything not in the table is returned as it came. The featured mod list is
 * open ended (`/data/featuredMod` is where it really lives, and a total
 * conversion can appear on it at any time), so an unknown id showing its own
 * name is the only answer that stays right.
 */
const NAMES: Record<string, MessageKey> = {
  faf: "lobby.host.mod.faf",
  fafbeta: "lobby.host.mod.fafbeta",
  fafdevelop: "lobby.host.mod.fafdevelop",
  nomads: "lobby.host.mod.nomads",
  coop: "lobby.host.mod.coop",
  ladder1v1: "lobby.host.mod.ladder1v1",
};

export function featuredModLabel(modName: string, fallback = "faf"): string {
  const id = (modName || fallback).toLocaleLowerCase();
  const key = NAMES[id];
  return key ? t(key) : modName || fallback;
}
