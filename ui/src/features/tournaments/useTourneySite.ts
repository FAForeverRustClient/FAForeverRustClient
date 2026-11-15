// Which of the tournament site's pages is showing, how one is opened, and the
// reads the tab keeps going while it is mounted: the first load and the
// pending-requests poll.

import { useForegroundInterval } from "../../shared/hooks/useForegroundInterval";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { SiteWrite } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import type { SitePage } from "./site/sitePages";
import { sitePageReads } from "./sitePageReads";
import { load, send, settle } from "./tourneyCommands";
import { clearTournamentDraft, pendingTournamentDraft, subscribeTournamentDraft } from "../../shared/tournamentNavigation";

export function useTourneySite() {
  /** Which of the site's pages is showing; the list and the detail by default. */
  const [page, setPage] = useState<SitePage>({ kind: "events" });
  /** A section the pending bar asked the detail to open. */
  const [jump, setJump] = useState<{ section: string; nonce: number } | null>(null);
  const draftRequest = useSyncExternalStore(subscribeTournamentDraft, pendingTournamentDraft);
  useEffect(() => {
    if (draftRequest === null) return;
    let disposed = false;
    ipc.run((async () => {
      const status = useAppStore.getState().state.tourney.status.type;
      if (status === "idle" || status === "loading") await settle({ type: "load" });
      if (disposed || pendingTournamentDraft()?.nonce !== draftRequest.nonce) return;
      setPage({ kind: "events" });
      send({ type: "select", payload: { tournamentId: draftRequest.tournamentId } });
      setJump({ section: "teams", nonce: draftRequest.nonce });
      clearTournamentDraft(draftRequest.nonce);
    })());
    return () => { disposed = true; };
  }, [draftRequest]);

  useEffect(() => {
    if (useAppStore.getState().state.tourney.status.type === "idle") {
      if (pendingTournamentDraft() === null) load();
      // Site-wide and cached for the session: the rules pages do not belong to
      // any one tournament, so they are fetched once rather than per event.
      send({ type: "loadArticles" });
      // Hosting is approval-only, granted per account. Asked once, because the
      // alternative is a create button that answers "not approved yet".
      send({ type: "loadHosting" });
      // This account's own Discord handle, so the signup dialog opens on what
      // the service already has rather than on an empty field that would clear
      // it if anybody pressed save.
      send({ type: "loadProfile" });
    }
  }, []);

  useForegroundInterval(() => send({ type: "loadSite", payload: { read: "pending" } }), 30_000);

  const siteWrite = (write: SiteWrite) => send({ type: "siteWrite", payload: { write } });
  /** Open a page, reading what it shows as it opens. */
  const openPage = (next: SitePage) => {
    setPage(next);
    for (const read of sitePageReads(next)) send(read);
  };
  const openEventPage = (tournamentId: string, section?: string) => {
    setPage({ kind: "events" });
    send({ type: "select", payload: { tournamentId } });
    if (section !== undefined) setJump({ section, nonce: Date.now() });
  };

  return { page, setPage, jump, siteWrite, openPage, openEventPage };
}
