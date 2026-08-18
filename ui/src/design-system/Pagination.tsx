import { useState } from "react";
import { useTranslation } from "../i18n/useTranslation";
import "./pagination.css";

/**
 * How many page buttons to show at once.
 *
 * Nine, not the Java client's ten. An odd count is what puts the current page
 * in the actual middle of the run: with ten there are four buttons on one side
 * and five on the other, which reads as off-centre because it is.
 */
export const MAX_PAGE_INDICATORS = 9;

export interface PaginationProps {
  currentPage: number;
  /**
   * `null` when the source cannot say how many pages exist, which the API does
   * for some replay queries. The window is then driven by `hasMore` alone: a
   * run of pages ahead of the current one, growing as the user advances,
   * rather than a single position with nothing to click.
   */
  totalPages: number | null;
  onPageChange: (page: number) => void;
  /**
   * Whether the source has more results than this page. Outranks
   * `totalPages`, which the API can under-report.
   */
  hasMore?: boolean;
  maxVisiblePages?: number;
  className?: string;
  ariaLabel?: string;
}

export type PageItem = { type: "page"; page: number; current: boolean };

/**
 * A sliding window of consecutive page numbers.
 *
 * Modelled on the Java client's `vault/VaultEntityController`, which shows a run
 * of *consecutive* pages around the current one and reaches the ends through
 * separate first and last buttons. No ellipsis anywhere. The one departure is
 * the count; see `MAX_PAGE_INDICATORS`.
 *
 * This used to pin page 1 and the last page and fill the gaps with clickable
 * ellipses. That put a "jump to page 1" control immediately next to a page 1
 * button that was always on screen, which is the redundancy that prompted this
 * rewrite.
 *
 * The window is always exactly `maxVisible` long once there are that many
 * pages, and every entry is a real page. Constant count matters because the row
 * is centred, so a changing entry count slides every button sideways as you
 * page; `pagination.css` gives the slots a uniform width for the same reason,
 * since "1" and "139" are not the same size.
 */
export function getPageItems(
  currentPage: number,
  totalPages: number,
  maxVisible: number = MAX_PAGE_INDICATORS,
): PageItem[] {
  if (totalPages <= 1) return [];

  const page = (p: number): PageItem => ({
    type: "page",
    page: p,
    current: p === currentPage,
  });

  if (totalPages <= maxVisible) {
    return Array.from({ length: totalPages }, (_, index) => page(index + 1));
  }

  // Centre the window on the current page, then push it back inside the range.
  // Clamping rather than shrinking is what keeps the count constant at both
  // ends of the range.
  const half = Math.floor((maxVisible - 1) / 2);
  const start = Math.min(Math.max(1, currentPage - half), totalPages - maxVisible + 1);
  return Array.from({ length: maxVisible }, (_, index) => page(start + index));
}

export function Pagination({
  currentPage,
  totalPages,
  onPageChange,
  hasMore = false,
  maxVisiblePages = MAX_PAGE_INDICATORS,
  className = "",
  ariaLabel,
}: PaginationProps) {
  const { t } = useTranslation();
  const [jump, setJump] = useState("");
  const unknownTotal = totalPages === null;
  if (!unknownTotal && totalPages <= 1 && !hasMore) return null;
  if (unknownTotal && currentPage <= 1 && !hasMore) return null;

  // The reported count is a floor, not a ceiling.
  //
  // `hasMore` outranks it: the API's totals for a very large collection can be
  // capped or estimated, and a full page of results is direct evidence another
  // exists. Clamping the window to the reported count is what left the replay
  // vault showing five buttons and no way past them; when the source says there
  // is more, the window keeps a full run of pages ahead of wherever the user
  // has reached, so clicking 10 offers up to 15 rather than dead-ending.
  const reach = hasMore ? currentPage + maxVisiblePages : currentPage;
  const effectiveTotal = unknownTotal ? reach : Math.max(totalPages, reach);
  const items = getPageItems(currentPage, effectiveTotal, maxVisiblePages);
  // Shown whenever the range is longer than the window, including when the
  // source reports more than its own count: the last button then targets the
  // highest page the server has actually claimed, and disables itself once the
  // user is past it, rather than disappearing exactly where it is most useful.
  const showEnds = !unknownTotal && effectiveTotal > maxVisiblePages;

  return (
    <nav className={`pagination ${className}`.trim()} aria-label={ariaLabel ?? t("designSystem.pagination.aria")}>
      {unknownTotal && (
        <span className="pagination-position" aria-current="page">
          {t("designSystem.pagination.page", { page: currentPage })}
        </span>
      )}

      {/* First and last, as separate controls rather than a clickable
          ellipsis: this is how the Java client reaches the ends of a long
          range. */}
      {showEnds && (
        <button
          type="button"
          className="pagination-btn pagination-end"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(1)}
          aria-label={t("designSystem.pagination.firstPage")}
          title={t("designSystem.pagination.firstPage")}
        >
          «
        </button>
      )}

      {items.map((item) => (
        <button
          key={`page-${item.page}`}
          type="button"
          className={`pagination-btn${item.current ? " active" : ""}`}
          onClick={() => onPageChange(item.page)}
          aria-label={t("designSystem.pagination.page", { page: item.page })}
          aria-current={item.current ? "page" : undefined}
        >
          {item.page}
        </button>
      ))}

      {showEnds && (
        <button
          type="button"
          className="pagination-btn pagination-end"
          disabled={currentPage >= (totalPages ?? 1)}
          onClick={() => onPageChange(totalPages ?? 1)}
          aria-label={t("designSystem.pagination.lastPage", { page: totalPages ?? 0 })}
          title={t("designSystem.pagination.lastPage", { page: totalPages ?? 0 })}
        >
          »
        </button>
      )}

      {/* Typing a page number. With hundreds of pages the window and the end
          buttons still leave the middle of the range several clicks away. */}
      <form
        className="pagination-jump"
        onSubmit={(event) => {
          event.preventDefault();
          const entered = Number.parseInt(jump, 10);
          if (!Number.isFinite(entered)) return;
          const highest = unknownTotal ? entered : totalPages;
          onPageChange(Math.min(Math.max(1, entered), Math.max(1, highest)));
          setJump("");
        }}
      >
        <input
          type="text"
          inputMode="numeric"
          value={jump}
          onChange={(event) => setJump(event.target.value.replace(/[^0-9]/g, ""))}
          placeholder={t("designSystem.pagination.goToPlaceholder")}
          aria-label={t("designSystem.pagination.goTo")}
          title={t("designSystem.pagination.goTo")}
        />
      </form>
    </nav>
  );
}
