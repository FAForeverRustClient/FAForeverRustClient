// @vitest-environment happy-dom
//
// The page size of a grid whose element comes and goes, mounted.
//
// An installed list draws its grid only while something matches. The hook
// used to measure the grid it found when the view mounted and nothing after:
// a filter that matched nothing took that grid off the page, the next
// measurement read a grid with no columns, and the list came back four cards
// to a page (#470's report). A list still loading when the view opened had
// no grid yet and was never measured at all. And it measured against the
// panel's bottom, which grows with the page, so a page taller than the screen
// measured itself as fitting.
//
// happy-dom has no layout, so the layout is stood in for, the way the shell
// lays a tab out: a scroll area (`.content`) 1000 pixels high, a panel inside
// it (`.content-inner`) as tall as what it holds, and a two-column grid 100
// pixels below the top. A grid that has left the page reports what a browser
// reports for one, no columns and an empty box. The resize observer is a
// stand-in that the test fires itself, the way the panel resizing does when
// an empty state takes the grid's place.

import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failOnConsoleError } from "../../testing/consoleGuard";
import "../../testing/mounted";
import { useGridPageSize } from "./useGridPageSize";

vi.mock("../../ipc/client");

failOnConsoleError();

/** A resize observer that reports only when the test says so. */
class ManualResizeObserver {
  static live = new Set<ManualResizeObserver>();

  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ManualResizeObserver.live.add(this);
  }

  observe() {}

  unobserve() {}

  disconnect() {
    ManualResizeObserver.live.delete(this);
  }

  /** Every observer still connected reports a resize. */
  static resize() {
    act(() => {
      for (const observer of [...ManualResizeObserver.live]) {
        observer.callback([], observer);
      }
    });
  }
}

const VISIBLE_HEIGHT_PX = 1000;
const GRID_TOP_PX = 100;
const ROW_GAP_PX = 12;
const DESIGNED_CARD_PX = 96;

/** How far the scroll area is scrolled, and where the panel inside it ends. */
let scrolledPx = 0;
let panelBottomPx = VISIBLE_HEIGHT_PX;

function box(top: number, bottom: number): DOMRect {
  return { top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top } as DOMRect;
}

/** The scroll area's own heights, which happy-dom leaves at zero. */
function scrollArea(element: HTMLElement | null) {
  if (!element) return;
  Object.defineProperty(element, "clientHeight", { configurable: true, get: () => VISIBLE_HEIGHT_PX });
  Object.defineProperty(element, "scrollTop", { configurable: true, get: () => scrolledPx });
}

beforeEach(() => {
  scrolledPx = 0;
  panelBottomPx = VISIBLE_HEIGHT_PX;
  vi.stubGlobal("ResizeObserver", ManualResizeObserver);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (!(this instanceof HTMLElement) || !this.isConnected) return box(0, 0);
    if (this.classList.contains("content")) return box(0, VISIBLE_HEIGHT_PX);
    // Everything inside the scroll area moves up as it scrolls.
    const top = GRID_TOP_PX - scrolledPx;
    if (this.classList.contains("content-inner")) return box(-scrolledPx, panelBottomPx - scrolledPx);
    if (this.classList.contains("grid")) return box(top, top);
    if (this.classList.contains("card")) return box(top, top + Number(this.dataset.height));
    return box(0, 0);
  });
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    if (element instanceof HTMLElement && element.classList.contains("grid")) {
      const placed = element.isConnected;
      return {
        gridTemplateColumns: placed ? "410px 410px" : "",
        rowGap: placed ? `${ROW_GAP_PX}px` : "",
      } as CSSStyleDeclaration;
    }
    return computed(element, pseudo);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  ManualResizeObserver.live.clear();
});

/** An installed list: the grid while something matches, an empty state otherwise. */
function List({ matching, cardHeight = DESIGNED_CARD_PX }: { matching: boolean; cardHeight?: number }) {
  const [pageSize, gridRef] = useGridPageSize(DESIGNED_CARD_PX, 48);
  return (
    <section className="content" ref={scrollArea}>
      <div className="content-inner">
        <div>
          <output aria-label="page size">{pageSize}</output>
          {matching ? (
            <div className="grid" ref={gridRef}>
              <article className="card" data-height={cardHeight} />
            </div>
          ) : (
            <p>Nothing matches</p>
          )}
        </div>
      </div>
    </section>
  );
}

function pageSize(): string | null {
  return screen.getByLabelText("page size").textContent;
}

// 1000 - 100 - 56 for the pager leaves 844 pixels. Rows of 96 with 12 between
// them: seven rows in 844, so fourteen cards in two columns.
const FITTED = "14";

describe("a grid's page size", () => {
  it("is measured from the grid on the page", () => {
    render(<List matching />);
    expect(pageSize()).toBe(FITTED);
  });

  it("is not lost when a filter matches nothing and comes back", () => {
    const { rerender } = render(<List matching />);
    expect(pageSize()).toBe(FITTED);

    // A search that matches nothing: the empty state takes the grid's place,
    // and the panel resizes around it.
    rerender(<List matching={false} />);
    ManualResizeObserver.resize();
    expect(pageSize(), "a grid off the page was measured").toBe(FITTED);

    // The search cleared: a new grid, measured as the old one was.
    rerender(<List matching />);
    ManualResizeObserver.resize();
    expect(pageSize(), "the new grid was never measured").toBe(FITTED);
  });

  it("is measured once a grid appears after the view opened", () => {
    // The installed list still loading: nothing to measure yet.
    const { rerender } = render(<List matching={false} />);
    expect(pageSize()).toBe("48");

    rerender(<List matching />);
    expect(pageSize()).toBe(FITTED);
  });

  it("counts a card taller than its design at its own height", () => {
    // Rows of 130: six rows in 844, so twelve cards, not the fourteen the
    // design would have promised and the panel could not show.
    render(<List matching cardHeight={130} />);
    expect(pageSize()).toBe("12");
  });

  it("is one screen, whatever the page under it measures or is scrolled to", () => {
    // A page three screens tall, read while scrolled down: the panel ends
    // far below the window. It used to measure itself as fitting there.
    panelBottomPx = 3000;
    scrolledPx = 300;
    render(<List matching />);
    expect(pageSize()).toBe(FITTED);
  });
});
