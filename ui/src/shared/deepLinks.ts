// What a `faf://` link opens, once the backend has read it.
//
// The backend parses every link, from chat or from the operating system, and
// puts the result in `nav.linkRequest` (faf-domain's `protocol::deep_link`).
// Opening it is the frontend's half, because several tabs open on one item
// through state that lives in the page: the map and mod vaults through their
// focus requests, the replay vault through a search request. So the shell
// watches for a request, opens it the way the tab's own buttons do, and says
// it has, which clears it.
//
// Nothing here starts a game or a download: a replay link opens the replay's
// entry in the vault, a map link the map's.

import { useEffect } from "react";
import type { DeepLink } from "../ipc/bindings";
import { ipc } from "../ipc/client";
import { useAppStore } from "../store/store";
import { requestMapVaultFocus } from "./mapVaultFocus";
import { requestModVaultFocus } from "./modVaultFocus";
import { EMPTY_REPLAY_QUERY } from "./replayQuery";
import { requestReplaySearch } from "./replaySearchIntent";

/** Ask the backend to open a link, from chat or anywhere else in the page. */
export function openLink(url: string) {
  ipc.send({ kind: "Nav", command: { type: "openLink", payload: { url } } });
}

/**
 * What to type into the map vault's search for a folder name.
 *
 * The vault searches display names, and a folder only spells one roughly:
 * `setons_clutch.v0004` is "Seton's Clutch", and the search glob would not
 * find "setons clutch" in it. So the search is the folder's longest word,
 * which the display name contains in nearly every case, and the vault then
 * selects the exact version among the results by its folder.
 */
export function mapSearchTerm(folderName: string): string {
  const base = folderName.replace(/\.v\d+$/i, "");
  const words = base.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // A tie goes to the later word: a possessive comes first more often than
  // not, and "setons" is not in "Seton's".
  return words.reduce((longest, word) => (word.length >= longest.length ? word : longest), "") || base;
}

/** Open what a link points at, the way that tab's own buttons do. */
export async function showLink(link: DeepLink): Promise<void> {
  switch (link.type) {
    case "tourney":
      await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "tournaments" } } });
      await ipc.settle({ kind: "Tourney", command: { type: "select", payload: { tournamentId: link.payload.id } } });
      return;
    case "map":
      requestMapVaultFocus({ name: mapSearchTerm(link.payload.folderName), folderName: link.payload.folderName });
      await ipc.settle({ kind: "Nav", command: { type: "selectMapsSection", payload: { section: "vault" } } });
      await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "maps" } } });
      return;
    case "mod":
      // A uid is found by the search that looks beyond names.
      requestModVaultFocus(link.payload.uid, "description");
      await ipc.settle({ kind: "Nav", command: { type: "selectModsSection", payload: { section: "vault" } } });
      await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "mods" } } });
      return;
    case "replay":
      requestReplaySearch({ ...EMPTY_REPLAY_QUERY, replayId: String(link.payload.id) });
      await ipc.settle({ kind: "Nav", command: { type: "selectReplaysSection", payload: { section: "online" } } });
      await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "replays" } } });
      return;
    case "changelog":
      await ipc.settle({ kind: "Nav", command: { type: "selectChangelogSection", payload: { section: "game" } } });
      await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "changelog" } } });
      await ipc.settle({ kind: "Changelog", command: { type: "select", payload: { id: link.payload.release } } });
      return;
    case "unit":
      await ipc.settle({ kind: "Nav", command: { type: "selectChangelogSection", payload: { section: "units" } } });
      await ipc.settle({ kind: "Nav", command: { type: "select", payload: { tab: "changelog" } } });
      await ipc.settle({ kind: "UnitHistory", command: { type: "select", payload: { id: link.payload.id } } });
      return;
  }
}

/**
 * Open each link request once. Mounted in the shell, which only exists once
 * somebody is signed in: a link that started the client waits through the
 * sign-in rather than being opened behind the login screen and forgotten.
 */
export function useLinkRequests() {
  const request = useAppStore((state) => state.state.nav.linkRequest);
  useEffect(() => {
    if (!request) return;
    const { id, link } = request;
    // Said first, so a second render while the tabs switch cannot open it again.
    ipc.send({ kind: "Nav", command: { type: "linkShown", payload: { id } } });
    ipc.run(showLink(link));
  }, [request]);
}
