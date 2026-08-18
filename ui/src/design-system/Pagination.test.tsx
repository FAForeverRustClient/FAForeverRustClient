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

  it("keeps the window inside the range at the beginning", () => {
    const items = getPageItems(2, 100, 10);
    expect(items.map((item) => item.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(items[1]?.current).toBe(true);
  });

  it("centres the window on the current page in the middle of a range", () => {
    const items = getPageItems(50, 100, 10);
    expect(items.map((item) => item.page)).toEqual([46, 47, 48, 49, 50, 51, 52, 53, 54, 55]);
    expect(items.find((item) => item.current)?.page).toBe(50);
  });

  it("keeps the window inside the range at the end", () => {
    const items = getPageItems(98, 100, 10);
    expect(items.map((item) => item.page)).toEqual([91, 92, 93, 94, 95, 96, 97, 98, 99, 100]);
    expect(items.find((item) => item.current)?.page).toBe(98);
  });

  it("renders a constant number of slots on every page of a long range", () => {
    // The row is centred, so a changing entry count slides every button
    // sideways as you page.
    const counts = new Set(
      Array.from({ length: 139 }, (_, i) => getPageItems(i + 1, 139, 10).length),
    );
    expect([...counts]).toEqual([10]);
  });

  it("shows consecutive pages, always including the current one", () => {
    for (let page = 1; page <= 139; page++) {
      const pages = getPageItems(page, 139, 10).map((item) => item.page);
      expect(pages).toEqual([...pages].sort((a, b) => a - b));
      expect(new Set(pages).size).toBe(pages.length);
      // Consecutive: no gaps, so no ellipsis is ever needed.
      expect(pages[pages.length - 1] - pages[0]).toBe(pages.length - 1);
      expect(pages).toContain(page);
      expect(pages[0]).toBeGreaterThanOrEqual(1);
      expect(pages[pages.length - 1]).toBeLessThanOrEqual(139);
    }
  });
});

describe("unknown total pages", () => {
  it("offers a run of pages ahead when the source says there are more", () => {
    // No totalPages from the API, but a full page came back. Showing only
    // 'Page 3' left the user with nothing to click; a run of numbered pages
    // ahead is what lets them keep going.
    const markup = renderToStaticMarkup(
      <Pagination currentPage={3} totalPages={null} hasMore onPageChange={() => {}} />,
    );

    expect(markup).toContain('Page 3');
    expect(markup).toContain('aria-label="Page 9"');
  });

  it("grows the run as the user advances past a reported total", () => {
    // Clicking 10 has to offer 15, not dead-end at a count the server
    // under-reported.
    const markup = renderToStaticMarkup(
      <Pagination currentPage={10} totalPages={5} hasMore onPageChange={() => {}} />,
    );
    expect(markup).toContain('aria-label="Page 14"');
    expect(markup).toContain('aria-current="page"');
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
    expect(markup).toContain('aria-label="Page 3" aria-current="page"');
    expect(markup).toContain("active");
  });

  // The Java client reaches the ends of a long range with dedicated first and
  // last buttons, not a clickable ellipsis next to an always-visible page 1.
  it("offers first and last buttons instead of an ellipsis on a long range", () => {
    const markup = renderToStaticMarkup(
      <Pagination currentPage={3} totalPages={139} onPageChange={() => {}} />,
    );

    // No ellipsis *control*; the jump field's placeholder legitimately has the
    // character in it.
    expect(markup).not.toContain("pagination-ellipsis");
    expect(markup).toContain("First page");
    expect(markup).toContain("Last page (139)");
    // A consecutive window, so page 139 is not among the numbered buttons here.
    expect(markup).not.toContain(String.raw`aria-label="Page 139"`);
  });

  it("keeps Next available when the source reports more results than the page count", () => {
    const markup = renderToStaticMarkup(
      <Pagination currentPage={5} totalPages={5} hasMore onPageChange={() => {}} />,
    );
    expect(markup).not.toContain(String.raw`aria-label="Next page" disabled`);
  });
});
