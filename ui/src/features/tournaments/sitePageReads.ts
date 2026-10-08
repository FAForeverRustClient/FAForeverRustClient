// What opening one of the site's pages reads, in the order it is asked for.

import type { TourneyCommand } from "../../ipc/bindings";
import type { SitePage } from "./site/sitePages";

/** The commands that fetch what `page` shows, sent as it opens. */
export function sitePageReads(page: SitePage): TourneyCommand[] {
  const reads: TourneyCommand[] = [];
  if (page.kind === "hall") reads.push({ type: "loadSite", payload: { read: "hallOfFame" } });
  if (page.kind === "console") reads.push({ type: "loadSite", payload: { read: "console" } });
  if (page.kind === "faq") reads.push({ type: "loadArticles" });
  if (page.kind === "access") {
    reads.push({ type: "loadSite", payload: { read: { access: { kind: page.access } } } });
  }
  if (page.kind === "series") {
    reads.push({ type: "loadSeries" });
    if (page.seriesId !== null) reads.push({ type: "openSeries", payload: { seriesId: page.seriesId } });
    else reads.push({ type: "closeSeries" });
  }
  return reads;
}
