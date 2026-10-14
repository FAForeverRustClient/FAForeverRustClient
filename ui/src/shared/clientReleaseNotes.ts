// Opening one of this client's releases in the Changelog tab, from outside it.
//
// Two places point at a release that way: the update banner's "What's new"
// and the What's new popup's "See all changes". Here so both send the same
// two commands: the tab first, then the release, which opens the tab's client
// section too (`NavCommand::SelectChangelogClientRelease`).

import type { AuthMode, ClientReleaseNotes } from "../ipc/bindings";
import { ipc } from "../ipc/client";

export function openClientRelease(version: string): void {
  ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "changelog" } } });
  ipc.send({ kind: "Nav", command: { type: "selectChangelogClientRelease", payload: { version } } });
}

/**
 * Whether the client's own changelog can show this release: its notes have
 * been read, and the session can open the Changelog tab at all. A session
 * without an account cannot (`OFFLINE_TABS`), and the tab it asked for would
 * quietly be some other one.
 */
export function canOpenClientRelease(notes: ClientReleaseNotes[], mode: AuthMode, version: string): boolean {
  return mode !== "offline" && notes.some((note) => note.version === version);
}
