import type { PartyState } from "../../ipc/bindings";

/** Shared by both reference clients; the owner name makes party channels stable. */
export const PARTY_CHANNEL_SUFFIX = "'sParty";

/**
 * Return the IRC room for an actual multi-player party.
 *
 * Solo party snapshots are an implementation detail of matchmaking and must
 * not create a private-looking IRC channel. The owner must also be present in
 * the snapshot so a stale owner id can never produce a malformed room name.
 */
export function partyChatChannel(party: PartyState): string | null {
  if (party.members.length < 2 || party.ownerId === null) return null;
  const owner = party.members.find((member) => member.playerId === party.ownerId);
  return owner?.name.trim() ? `#${owner.name}${PARTY_CHANNEL_SUFFIX}` : null;
}
