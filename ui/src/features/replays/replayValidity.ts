// Why a game did not count, and therefore why it has no result to show.
//
// `game.validity` is the server's verdict (`server/games/game.py`'s
// `ValidityState`). The Java client keys a label off every value of it
// (`com.faforever.commons.api.dto.Validity`, whose `i18nKey` per constant is
// mirrored below one for one) and shows "Game was not rated. Reason: X" in
// place of the result whenever the game was not rated.
//
// The set grows on the server, so an unrecognised value is reported verbatim
// rather than swallowed: a replay that says `Reason: SOME_NEW_STATE` is worse
// than a translated string and far better than a blank line.

import type { MessageKey } from "../../i18n";
import { t } from "../../i18n";
import type { ReplayPlayer, ReplayTeam } from "../../ipc/bindings";

/** The server value that means the game counted. */
export const VALID = "VALID";

const REASON_KEYS: Record<string, MessageKey> = {
  TOO_MANY_DESYNCS: "replays.notRated.desync",
  WRONG_VICTORY_CONDITION: "replays.notRated.wrongCondition",
  NO_FOG_OF_WAR: "replays.notRated.fogOfWar",
  CHEATS_ENABLED: "replays.notRated.cheats",
  PREBUILT_ENABLED: "replays.notRated.prebuilt",
  NORUSH_ENABLED: "replays.notRated.noRush",
  BAD_UNIT_RESTRICTIONS: "replays.notRated.unitRestriction",
  BAD_MAP: "replays.notRated.unrankedMap",
  TOO_SHORT: "replays.notRated.short",
  BAD_MOD: "replays.notRated.unrankedMod",
  COOP_NOT_RANKED: "replays.notRated.coop",
  MUTUAL_DRAW: "replays.notRated.draw",
  SINGLE_PLAYER: "replays.notRated.singlePlayer",
  FFA_NOT_RANKED: "replays.notRated.ffa",
  UNEVEN_TEAMS_NOT_RANKED: "replays.notRated.unevenTeams",
  UNKNOWN_RESULT: "replays.notRated.unknown",
  TEAMS_UNLOCKED: "replays.notRated.teamsUnlocked",
  MULTIPLE_TEAMS: "replays.notRated.multipleTeams",
  HAS_AI: "replays.notRated.ai",
  CIVILIANS_REVEALED: "replays.notRated.civiliansRevealed",
  WRONG_DIFFICULTY: "replays.notRated.difficulty",
  EXPANSION_DISABLED: "replays.notRated.expansion",
  SPAWN_NOT_FIXED: "replays.notRated.spawn",
  OTHER_UNRANK: "replays.notRated.other",
  UNRANKED_BY_HOST: "replays.notRated.unrankedByHost",
};

/**
 * Whether this game actually produced a rating change, and therefore has a
 * result worth displaying.
 *
 * Both halves matter, and they are the two Java ANDs together for its "show
 * rating change" button: the server has to call the game valid, *and* a rating
 * journal has to carry an "after". A game can be `VALID` and still be waiting
 * for the rating to be computed.
 */
export function isRated(validity: string, teams: ReplayTeam[]): boolean {
  if (validity !== VALID) return false;
  return teams.some((team) =>
    team.players.some((player: ReplayPlayer) => player.ratingChange !== null && player.ratingChange !== undefined),
  );
}

/**
 * The line that replaces the result for an unrated game.
 *
 * An empty validity is a listing that did not carry one, which is not the same
 * as a game that was refused: Java says "not yet available" there, because the
 * usual cause is a game whose rating has not been computed yet.
 */
export function notRatedReason(validity: string): string {
  if (!validity) return t("replays.notRated.pending");
  const key = REASON_KEYS[validity];
  return t("replays.notRated.reason", { reason: key ? t(key) : validity });
}
