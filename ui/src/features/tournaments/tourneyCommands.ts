// The tab's way out to the backend, shared by the view and the parts it is
// split into.

import type { AppCommand, TourneyCommand } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";

/** Every command this tab sends is a tourney command; this is the only wrapper. */
export const send = (command: TourneyCommand) =>
  ipc.send({ kind: "Tourney", command } satisfies AppCommand);

/**
 * Reload what the tab shows.
 *
 * Hosting rides along rather than being asked once at startup. It is granted
 * per account by the site admin, so it changes *while* the client runs, and a
 * refresh that left it alone meant the create button stayed missing until the
 * whole client was restarted, with no way to tell that from being refused.
 */
export const load = () => {
  send({ type: "load" });
  send({ type: "loadHosting" });
};
