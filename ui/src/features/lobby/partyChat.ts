import type { PartyState, Player, SocialState } from "../../ipc/bindings";

/** Shared by both reference clients; the owner name makes party channels stable. */
export const PARTY_CHANNEL_SUFFIX = "'sParty";

/**
 * Characters that cannot appear in an IRC channel name.
 *
 * A space is the one that actually bit: the lobby's `update_party` carries no
 * names at all, so the adapter labels every member "Player 123456", and the
 * owner's label went straight into the room name. The client then sent
 * `JOIN :#Player 42707'sParty`, which the server read as a channel it does not
 * have and answered with `403 No such channel`, leaving the panel waiting on a
 * room that could never arrive.
 */
const ILLEGAL_IN_CHANNEL_NAME = /[\s,:]/;

/**
 * The owner's real login, resolved the way the rest of the client resolves a
 * player id: against the live directory, with the signed-in account as its own
 * answer. Empty when nothing knows this id yet, which is a normal state right
 * after a party message and resolves itself when `player_info` lands.
 */
function ownerLogin(party: PartyState, social: SocialState, self: Player | null): string {
  if (party.ownerId === null) return "";
  // `||`, not `??`: an empty login is as useless as a missing one, and the
  // adapter's "Player 123456" is never an answer here at all.
  return social.players.find((player) => player.id === party.ownerId)?.login
    || (self?.id === party.ownerId ? self.name : "")
    || "";
}

/**
 * Return the IRC room for an actual multi-player party.
 *
 * Solo party snapshots are an implementation detail of matchmaking and must
 * not create a private-looking IRC channel. The owner must also be present in
 * the snapshot so a stale owner id can never produce a malformed room name.
 *
 * `null` also covers "the owner's login is not known yet". That is better than
 * guessing: a JOIN sent under a placeholder name is refused by the server and
 * never retried, whereas returning `null` lets the next directory update build
 * the real name.
 */
export function partyChatChannel(
  party: PartyState,
  social: SocialState,
  self: Player | null,
): string | null {
  if (party.members.length < 2 || party.ownerId === null) return null;
  if (!party.members.some((member) => member.playerId === party.ownerId)) return null;
  const login = ownerLogin(party, social, self).trim();
  if (!login || ILLEGAL_IN_CHANNEL_NAME.test(login)) return null;
  return `#${login}${PARTY_CHANNEL_SUFFIX}`;
}
