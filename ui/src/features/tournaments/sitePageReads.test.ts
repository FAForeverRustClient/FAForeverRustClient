import { describe, expect, it } from "vitest";

import { sitePageReads } from "./sitePageReads";

describe("sitePageReads", () => {
  it("reads nothing for the event list, which the tab keeps loaded itself", () => {
    expect(sitePageReads({ kind: "events" })).toEqual([]);
  });

  it("reads the site page each page shows", () => {
    expect(sitePageReads({ kind: "hall" })).toEqual([{ type: "loadSite", payload: { read: "hallOfFame" } }]);
    expect(sitePageReads({ kind: "console" })).toEqual([{ type: "loadSite", payload: { read: "console" } }]);
    expect(sitePageReads({ kind: "faq", articleId: null })).toEqual([{ type: "loadArticles" }]);
    expect(sitePageReads({ kind: "access", access: "importer" })).toEqual([
      { type: "loadSite", payload: { read: { access: { kind: "importer" } } } },
    ]);
  });

  it("loads the series list, then opens or closes one series", () => {
    expect(sitePageReads({ kind: "series", seriesId: "s1" })).toEqual([
      { type: "loadSeries" },
      { type: "openSeries", payload: { seriesId: "s1" } },
    ]);
    expect(sitePageReads({ kind: "series", seriesId: null })).toEqual([
      { type: "loadSeries" },
      { type: "closeSeries" },
    ]);
  });
});
