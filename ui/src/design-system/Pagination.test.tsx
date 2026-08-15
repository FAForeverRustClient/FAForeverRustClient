import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getPageItems, Pagination } from "./Pagination";

describe("getPageItems", () => {
  it("returns empty array when totalPages <= 1", () => {
    expect(getPageItems(1, 1)).toEqual([]);
    expect(getPageItems(1, 0)).toEqual([]);
  });

  it("returns every page when the range fits in the slots", () => {
    const items = getPageItems(3, 5, 9);
    expect(items).toEqual([
      { type: "page", page: 1, current: false },
      { type: "page", page: 2, current: false },
      { type: "page", page: 3, current: true },
      { type: "page", page: 4, current: false },
      { type: "page", page: 5, current: false },
    ]);
  });

  it("fills the leading slot with a page, not a gap, when at the beginning", () => {
    const items = getPageItems(2, 100, 9);
    expect(items[0]).toEqual({ type: "page", page: 1, current: false });
    expect(items[1]).toEqual({ type: "page", page: 2, current: true });
    // Exactly one ellipsis here, at the far end. The slot a leading ellipsis
    // would occupy holds a real page instead, so there is no empty hole.
    expect(items.filter((item) => item.type === "ellipsis")).toHaveLength(1);
    expect(items[items.length - 2]?.type).toBe("ellipsis");
    expect(items[items.length - 1]).toEqual({ type: "page", page: 100, current: false });
  });

  it("shows both ellipses in the middle of a large range", () => {
    const items = getPageItems(50, 100, 9);
    expect(items.filter((item) => item.type === "ellipsis")).toHaveLength(2);
    expect(items[0]).toEqual({ type: "page", page: 1, current: false });
    const page50 = items.find((item) => item.type === "page" && item.page === 50);
    expect(page50?.type === "page" && page50.current).toBe(true);
    expect(items[items.length - 1]).toEqual({ type: "page", page: 100, current: false });
  });

  it("fills the trailing slot with a page when near the end", () => {
    const items = getPageItems(98, 100, 9);
    expect(items[0]).toEqual({ type: "page", page: 1, current: false });
    expect(items[1]?.type).toBe("ellipsis");
    expect(items.filter((item) => item.type === "ellipsis")).toHaveLength(1);
    expect(items[items.length - 1]).toEqual({ type: "page", page: 100, current: false });
  });

  it("renders a constant number of slots on every page of a long range", () => {
    // The bug this guards: the ellipsis slots used to come and go, so the row
    // changed width between pages and, being centred, slid every button
    // sideways as you paged.
    const counts = new Set(
      Array.from({ length: 139 }, (_, i) => getPageItems(i + 1, 139, 9).length),
    );
    expect([...counts]).toEqual([9]);
  });

  it("never leaves a slot empty and never repeats or skips a page", () => {
    // The second bug: reserving the slot with an invisible placeholder kept the
    // count constant but punched a visible hole in the row.
    for (let page = 1; page <= 139; page++) {
      const items = getPageItems(page, 139, 9);
      expect(items.every((item) => item.type === "page" || item.type === "ellipsis")).toBe(true);

      const pages = items.flatMap((item) => (item.type === "page" ? [item.page] : []));
      expect(pages).toEqual([...pages].sort((a, b) => a - b));
      expect(new Set(pages).size).toBe(pages.length);
      expect(pages[0]).toBe(1);
      expect(pages[pages.length - 1]).toBe(139);
      expect(pages).toContain(page);
    }
  });
});

describe("unknown total pages", () => {
  it("shows position and direction instead of invented page numbers", () => {
    // The replay vault gets no `totalPages` from the API for some queries. It
    // used to guess, so the numbered buttons appeared one at a time as you
    // clicked through: pages 1 and 2, then 3, then 4.
    const markup = renderToStaticMarkup(
      <Pagination currentPage={3} totalPages={null} hasMore onPageChange={() => {}} />,
    );

    expect(markup).toContain("Page 3");
    expect(markup).not.toContain('class="pagination-btn"');
    expect(markup).toContain('aria-label="Next page"');
    expect(markup).toContain('aria-label="Previous page"');
  });

  it("disables Next at the end of an unknown range", () => {
    const markup = renderToStaticMarkup(
      <Pagination currentPage={3} totalPages={null} hasMore={false} onPageChange={() => {}} />,
    );
    expect(markup).toMatch(/aria-label="Next page"[^>]*disabled|disabled[^>]*aria-label="Next page"/);
  });

  it("renders nothing when there is one unknown page and no more to come", () => {
    expect(
      renderToStaticMarkup(
        <Pagination currentPage={1} totalPages={null} hasMore={false} onPageChange={() => {}} />,
      ),
    ).toBe("");
  });
});

describe("Pagination component", () => {
  it("renders empty when totalPages <= 1", () => {
    const markup = renderToStaticMarkup(
      <Pagination currentPage={1} totalPages={1} onPageChange={() => {}} />,
    );
    expect(markup).toBe("");
  });

  it("renders page buttons and marks current page as active", () => {
    const markup = renderToStaticMarkup(
      <Pagination currentPage={3} totalPages={10} onPageChange={() => {}} />,
    );

    expect(markup).toContain('class="pagination"');
    expect(markup).toContain("Previous");
    expect(markup).toContain("Next");
    expect(markup).toContain('aria-label="Page 3" aria-current="page"');
    expect(markup).toContain("active");
  });

  it("renders jump ellipses for large total page counts", () => {
    const markup = renderToStaticMarkup(
      <Pagination currentPage={3} totalPages={139} onPageChange={() => {}} />,
    );

    expect(markup).toContain("Jump to page 13");
    expect(markup).toContain("…");
    expect(markup).toContain('aria-label="Page 139"');
  });
});
