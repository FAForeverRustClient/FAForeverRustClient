/**
 * The one entry point for joining a custom game, and the retry that follows a
 * simulation-mod conflict.
 *
 * Joining can stop before the request reaches the server: a game may need a
 * mod version whose folder is already occupied by a different one, and that is
 * the user's call to make (`ModReplacementDialog`). Answering it means sending
 * the *same* join again, and a password-protected lobby needs the password
 * with it. The password is deliberately not part of the shared state the
 * backend broadcasts, so the last request is remembered here instead: it stays
 * in the renderer, is overwritten by the next join, and is never read for a
 * different game than the one it was typed for.
 */
import { ipc } from "../../ipc/client";

let lastRequest: { id: number; password: string | null } | null = null;

const send = (id: number, password: string | null, replaceMods: boolean) =>
  ipc.send({
    kind: "Lobby",
    command: { type: "join", payload: { id, password, replaceMods } },
  });

/** Join a game. Every entry point in the client goes through this. */
export function joinGame(id: number, password: string | null = null) {
  lastRequest = { id, password };
  return send(id, password, false);
}

/**
 * Re-send the join that stopped on a mod conflict, approving the replacement.
 *
 * The password comes from the attempt that was interrupted; a stale one from
 * some earlier game is ignored rather than sent to the wrong lobby.
 */
export function joinReplacingMods(id: number) {
  const password = lastRequest?.id === id ? lastRequest.password : null;
  return send(id, password, true);
}
