import { Button } from "./Button";
import { t } from "../i18n";
import { useTranslation } from "../i18n/useTranslation";
import "./pagination.css";

export interface PaginationProps {
  currentPage: number;
  /**
   * `null` when the source cannot say how many pages exist.
   *
   * The online replay vault is in that position whenever the API omits
   * `meta.page.totalPages`. It used to guess "current page, plus one more if
   * this page was full", so the numbered buttons *grew as you clicked*: pages 1
   * and 2, then 3 appeared, then 4. Rendering numbers the caller does not have
   * is worse than admitting it, so an unknown total shows position and
   * direction only.
   */
  totalPages: number | null;
  onPageChange: (page: number) => void;
  /** Only consulted when `totalPages` is null: whether Next is available. */
  hasMore?: boolean;
  maxVisiblePages?: number;
  className?: string;
  ariaLabel?: string;
}

export type PageItem =
  | { type: "page"; page: number; current: boolean }
  | { type: "ellipsis"; jumpTo: number; label: string };

/**
 * The page controls, as a fixed number of slots.
 *
 * `maxVisible` is the total slot count, first and last page included. Once the
 * range is longer than that, the list always has exactly `maxVisible` entries
 * and every entry is either a page or an ellipsis: never an empty gap.
 *
 * Two earlier attempts at this were wrong, so both are spelled out. Letting the
 * ellipsis slots simply appear and disappear changed the entry count between
 * pages, and since the row is centred every button slid sideways as you paged.
 * Reserving those slots with an invisible placeholder fixed the count but left
 * a visible hole in the row. Constant count is also not sufficient on its own:
 * "1" and "139" are different widths, so the slots are given a uniform width in
 * `pagination.css` as well. Count and width both have to be constant.
 */
export function getPageItems(
  currentPage: number,
  totalPages: number,
  maxVisible: number = 9,
): PageItem[] {
  if (totalPages <= 1) return [];

  const page = (p: number): PageItem => ({
    type: "page",
    page: p,
    current: p === currentPage,
  });

  // Short enough to show whole: no ellipsis needed, so no slot arithmetic.
  if (totalPages <= maxVisible) {
    return Array.from({ length: totalPages }, (_, i) => page(i + 1));
  }

  // Slots between the pinned first and last pages.
  const middle = maxVisible - 2;
  // Page slots left once both ellipses are shown.
  const window = middle - 2;
  const edge = 1 + Math.ceil(middle / 2);

  const jump = (to: number): PageItem => ({
    type: "ellipsis",
    jumpTo: to,
    label: t("designSystem.pagination.jumpTo", { page: to }),
  });

  const items: PageItem[] = [page(1)];

  if (currentPage <= edge) {
    // Near the start: no leading ellipsis, so the slot it would have taken
    // holds a real page instead of a gap.
    for (let p = 2; p <= middle; p++) items.push(page(p));
    items.push(jump(Math.min(totalPages, currentPage + 10)));
  } else if (currentPage >= totalPages - edge + 1) {
    items.push(jump(Math.max(1, currentPage - 10)));
    for (let p = totalPages - middle + 1; p <= totalPages - 1; p++) items.push(page(p));
  } else {
    items.push(jump(Math.max(1, currentPage - 10)));
    const start = currentPage - Math.floor((window - 1) / 2);
    for (let p = start; p < start + window; p++) items.push(page(p));
    items.push(jump(Math.min(totalPages, currentPage + 10)));
  }

  items.push(page(totalPages));
  return items;
}

export function Pagination({
  currentPage,
  totalPages,
  onPageChange,
  hasMore = false,
  maxVisiblePages = 9,
  className = "",
  ariaLabel,
}: PaginationProps) {
  const { t } = useTranslation();
  const unknownTotal = totalPages === null;
  if (!unknownTotal && totalPages <= 1) return null;
  if (unknownTotal && currentPage <= 1 && !hasMore) return null;

  const items = unknownTotal ? [] : getPageItems(currentPage, totalPages, maxVisiblePages);
  const atEnd = unknownTotal ? !hasMore : currentPage >= totalPages;

  return (
    <nav className={`pagination ${className}`.trim()} aria-label={ariaLabel ?? t("designSystem.pagination.aria")}>
      <Button
        className="pagination-nav"
        disabled={currentPage <= 1}
        onClick={() => onPageChange(currentPage - 1)}
        aria-label={t("designSystem.pagination.previousPage")}
      >
        {t("designSystem.pagination.previous")}
      </Button>

      {unknownTotal && (
        <span className="pagination-position" aria-current="page">
          {t("designSystem.pagination.page", { page: currentPage })}
        </span>
      )}

      {items.map((item, index) => {
        if (item.type === "ellipsis") {
          return (
            <button
              key={`ellipsis-${index}`}
              type="button"
              className="pagination-ellipsis"
              onClick={() => onPageChange(item.jumpTo)}
              title={item.label}
              aria-label={item.label}
            >
              …
            </button>
          );
        }

        return (
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
        );
      })}

      <Button
        className="pagination-nav"
        disabled={atEnd}
        onClick={() => onPageChange(currentPage + 1)}
        aria-label={t("designSystem.pagination.nextPage")}
      >
        {t("designSystem.pagination.next")}
      </Button>
    </nav>
  );
}
