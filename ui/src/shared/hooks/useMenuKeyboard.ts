import { useEffect, useRef, type RefObject } from "react";
import { nextListboxIndex } from "../listboxNavigation";

// Joined from single selectors, like `Modal`'s, so it never reads as copy.
const FOCUSABLE = ["a[href]", "button", "input", "select", "textarea", "[tabindex]"].join(",");

/**
 * Focus a menu's first item on open and move between items with the arrow
 * keys, Home and End. Escape stays with the shared overlay stack.
 *
 * Only the focused item is in the Tab order, so Tab still reaches any other
 * control the menu holds (the player menu's name colour) and closes the menu
 * once it would leave it.
 */
export function useMenuKeyboard(
  menuRef: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const allItems = () => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const items = () => allItems()
      .filter((item) => !item.matches(':disabled, [aria-disabled="true"]') && !item.closest('[hidden], [aria-hidden="true"]'));
    const rove = (active: HTMLElement | undefined) => {
      for (const item of allItems()) item.tabIndex = item === active ? 0 : -1;
    };
    const first = items()[0];
    rove(first);
    first?.focus({ preventScroll: true });

    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target.matches('[role="menuitem"]')) rove(event.target);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab") {
        const order = Array.from(menu.querySelectorAll<HTMLElement>(FOCUSABLE))
          .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[hidden]"));
        const at = order.indexOf(document.activeElement as HTMLElement);
        const leaving = at === -1 || (event.shiftKey ? at === 0 : at === order.length - 1);
        if (!leaving) return;
        previous?.focus({ preventScroll: true });
        close.current();
        return;
      }
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      const entries = items();
      const current = entries.findIndex((entry) => entry === document.activeElement);
      // Arrows anywhere else in the menu (the name colour's controls) are theirs.
      if (current === -1) return;
      const next = nextListboxIndex(event.key, current, entries.length);
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      entries[next]?.focus();
    };
    menu.addEventListener("focusin", onFocusIn);
    menu.addEventListener("keydown", onKeyDown);
    return () => {
      menu.removeEventListener("focusin", onFocusIn);
      menu.removeEventListener("keydown", onKeyDown);
    };
  }, [menuRef, open]);
}
