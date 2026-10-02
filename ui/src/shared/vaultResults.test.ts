import { describe, expect, it } from "vitest";
import { localPage, ratingLowerBound, vaultPageOutcome, vaultSearchText } from "./vaultResults";

const FACTS = { settled: true, received: 36, shown: 36, currentPage: 1, totalPages: 5 };

describe("vaultPageOutcome", () => {
  it("shows results and the pager when the page has something", () => {
    expect(vaultPageOutcome(FACTS)).toEqual({ kind: "results", showPager: true, nextPage: null });
  });

  it("keeps the pager and points onward when the install filter emptied a page", () => {
    // The reported bug: "Installed" on page 1 of 5 left nothing, the pager
    // vanished and the tab said no maps match, with four pages unread.
    expect(vaultPageOutcome({ ...FACTS, shown: 0 })).toEqual({
      kind: "filteredOnPage",
      showPager: true,
      nextPage: 2,
    });
  });

  it("has no next page to offer from the last one, but keeps the pager", () => {
    expect(vaultPageOutcome({ ...FACTS, shown: 0, currentPage: 5 })).toEqual({
      kind: "filteredOnPage",
      showPager: true,
      nextPage: null,
    });
  });

  it("keeps the note and pager while the next page loads", () => {
    expect(vaultPageOutcome({ ...FACTS, shown: 0, settled: false }).kind).toBe("filteredOnPage");
  });

  it("calls a filtered single-page search a real no-match", () => {
    // One page is the whole search, so nothing anywhere passed the filter.
    expect(vaultPageOutcome({ ...FACTS, shown: 0, totalPages: 1 })).toEqual({
      kind: "noMatch",
      showPager: false,
      nextPage: null,
    });
  });

  it("calls an empty search a no-match", () => {
    expect(vaultPageOutcome({ ...FACTS, received: 0, shown: 0, totalPages: 1 }).kind).toBe("noMatch");
  });

  it("does not claim no matches when an empty page belongs to a longer search", () => {
    expect(vaultPageOutcome({ ...FACTS, received: 0, shown: 0, currentPage: 2 })).toEqual({
      kind: "emptyPage",
      showPager: true,
      nextPage: 3,
    });
  });

  it("says nothing while an unpaged search is still on its way", () => {
    expect(vaultPageOutcome({ ...FACTS, received: 0, shown: 0, totalPages: 1, settled: false }).kind)
      .toBe("waiting");
  });
});

describe("localPage", () => {
  const items = Array.from({ length: 7 }, (_, index) => index);

  it("counts pages from the list it is given", () => {
    expect(localPage(items, 2, 3)).toEqual({ items: [3, 4, 5], currentPage: 2, totalPages: 3 });
  });

  it("clamps a page the list no longer has", () => {
    expect(localPage(items, 9, 3)).toEqual({ items: [6], currentPage: 3, totalPages: 3 });
  });

  it("is one empty page for an empty list", () => {
    expect(localPage([], 4, 3)).toEqual({ items: [], currentPage: 1, totalPages: 1 });
  });
});

describe("vaultSearchText", () => {
  it("strips what the query strips and folds case", () => {
    expect(vaultSearchText(`Seton's "Clutch"*`)).toBe("setons clutch");
  });
});

describe("ratingLowerBound", () => {
  it("ranks many reviews above a few at a slightly higher average", () => {
    expect(ratingLowerBound(48, 200)).toBeGreaterThan(ratingLowerBound(50, 1));
  });

  it("ranks more reviews higher at the same average", () => {
    expect(ratingLowerBound(40, 50)).toBeGreaterThan(ratingLowerBound(40, 5));
  });

  it("puts unreviewed records last", () => {
    expect(ratingLowerBound(0, 0)).toBeLessThan(ratingLowerBound(10, 1));
  });
});
