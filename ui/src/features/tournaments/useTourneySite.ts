// Which of the tournament site's pages is showing, how one is opened, and the
// reads the tab keeps going while it is mounted: the first load and the
// pending-requests poll.

import { useEffect, useState } from "react";
import type { SiteWrite } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import type { SitePage } from "./site/sitePages";
import { sitePageReads } from "./sitePageReads";
import { load, send } from "./tourneyCommands";

export function useTourneySite() {
  /** Which of the site's pages is showing; the list and the detail by default. */
  const [page, setPage] = useState<SitePage>({ kind: "events" });
  /** A section the pending bar asked the detail to open. */
  const [jump, setJump] = useState<{ section: string; nonce: number } | null>(null);

  useEffect(() => {
    if (useAppStore.getState().state.tourney.status.type === "idle") {
      load();
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

  useEffect(() => {
    const poll = () => send({ type: "loadSite", payload: { read: "pending" } });
    poll();
    const timer = window.setInterval(poll, 30_000);
    return () => window.clearInterval(timer);
  }, []);

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
