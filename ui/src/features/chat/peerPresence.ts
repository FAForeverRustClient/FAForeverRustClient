import type { ChatChannel, LobbyStatus, SocialState } from "../../ipc/bindings";
import { nickKey } from "../../shared/nameColorsUtil";
import { findPlayer } from "../../store/reducer";

/**
 * Whether the person on the other side of a private conversation is connected.
 *
 * `unknown` is an answer of its own, and the panel prints nothing for it: a
 * wrong "offline" is worse than none, because it tells somebody not to bother
 * writing to a player who is sitting right there.
 */
export type PeerPresence = "online" | "offline" | "unknown";

/**
 * Read from what the client already holds, with no request of its own.
 *
 * The lobby's player directory is the server's own list of who is online:
 * everybody at login, then each arrival, and each departure as an explicit
 * `offline` notice. It is the list the friend-online notifications compare
 * against too. A name in it is online.
 *
 * A name in one of our channel rosters is online as well, whatever the lobby
 * says: IRC drops a nickname from every roster when its connection quits, and
 * somebody on chat without the client (an IRC-only nickname) can still read
 * what we write. IRC tells us nothing about anybody outside the channels we
 * share, which is why it only ever answers "online".
 *
 * Absence means offline only once the directory is the whole list. Without a
 * lobby connection it is empty. With one, `welcome` introduces our own account
 * a message before the list of everybody else arrives, and in that gap every
 * name is missing from it. So the directory counts as arrived when it holds
 * somebody other than `self` (the signed-in login).
 */
export function peerPresence(
  peer: string,
  self: string,
  social: SocialState,
  lobbyStatus: LobbyStatus,
  channels: ChatChannel[],
): PeerPresence {
  if (findPlayer(social, peer)) return "online";
  const peerKey = nickKey(peer);
  const onChat = channels.some((channel) => channel.users.some((user) => nickKey(user.name) === peerKey));
  if (onChat) return "online";
  if (lobbyStatus !== "connected") return "unknown";
  const selfKey = nickKey(self);
  const arrived = social.players.some((player) => nickKey(player.login) !== selfKey);
  return arrived ? "offline" : "unknown";
}
