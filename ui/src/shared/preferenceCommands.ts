// Writes to one entry of a list or map preference.
//
// Each names the one entry and what should happen to it, and the backend
// applies that to the collection it holds. Building the whole list or map here
// instead, from the store's snapshot, lost changes: two clicks inside one
// round trip both started from the same snapshot, so the second write did not
// hold the first. Several screens mute players and colour names, so the
// commands live in one place rather than once per menu.

import { ipc } from "../ipc/client";

/** Give a player's name a chat colour, or clear it with `null`. */
export function setPlayerNameColor(player: string, color: string | null): void {
  ipc.send({
    kind: "Settings",
    command: { type: "setPlayerNameColor", payload: { player, color } },
  });
}

/** Mute or unmute a player's chat messages. */
export function setPlayerMuted(player: string, muted: boolean): void {
  ipc.send({
    kind: "Settings",
    command: {
      type: "setListMember",
      payload: { list: "mutedPlayers", value: player, member: muted },
    },
  });
}
