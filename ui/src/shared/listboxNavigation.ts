// Keyboard navigation for the `role="listbox"` columns in the host dialogs.
//
// The rows are focusable buttons, so the browser moves *focus* between them
// with Tab - but nothing moved the *selection*, and the arrow keys only
// scrolled the container. Everything those columns exist to show (the map
// preview, its size and player count, a mission's briefing) hangs off the
// selection, so walking the list from the keyboard showed none of it.

/** How far PageUp/PageDown travel. A screenful of rows, near enough. */
const PAGE = 10;

function clamp(index: number, count: number): number {
  return Math.min(Math.max(index, 0), count - 1);
}

/**
 * The row `key` moves to, or `null` when the list does not handle that key.
 *
 * `current` is the selected row, or a negative number when nothing is selected
 * yet - any navigation key then lands on the first row. Deliberately does not
 * wrap: running off the end of a four-hundred-map list and reappearing at the
 * top is disorienting, and the ARIA listbox pattern treats wrapping as
 * optional.
 */
export function nextListboxIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  if (current < 0) {
    return ["ArrowDown", "ArrowUp", "Home", "End", "PageDown", "PageUp"].includes(key) ? 0 : null;
  }
  switch (key) {
    case "ArrowDown":
      return clamp(current + 1, count);
    case "ArrowUp":
      return clamp(current - 1, count);
    case "PageDown":
      return clamp(current + PAGE, count);
    case "PageUp":
      return clamp(current - PAGE, count);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** How much wheel travel is one row: a mouse notch is 100 or 120. */
const WHEEL_STEP = 50;

/**
 * Turns Ctrl+wheel into whole rows (#642): the plain wheel scrolls a column,
 * and with Ctrl held it walks the selection, a row per notch, the way the
 * arrow keys do.
 *
 * Travel is gathered until it makes a row, because a touchpad sends a stream
 * of small deltas where a mouse sends one large one; without that, a short
 * swipe would race through dozens of maps.
 */
export class WheelStepper {
  private travel = 0;

  /** The row the wheel moves to, or `null` when it is left to scroll. */
  next(event: { ctrlKey: boolean; deltaY: number }, current: number, count: number): number | null {
    if (!event.ctrlKey) {
      this.travel = 0;
      return null;
    }
    this.travel += event.deltaY;
    if (Math.abs(this.travel) < WHEEL_STEP) return current;
    const key = this.travel > 0 ? "ArrowDown" : "ArrowUp";
    this.travel = 0;
    return nextListboxIndex(key, current, count);
  }
}

/**
 * Move focus onto the row that was just selected.
 *
 * The rows are already in the DOM - only their `active` class changes - so this
 * can run in the same tick as the state update. `focus()` also brings the row
 * into view, which is the other half of what arrow-key navigation has to do.
 */
export function focusListboxOption(container: HTMLElement | null, index: number): void {
  const options = container?.querySelectorAll<HTMLElement>('[role="option"]');
  options?.[index]?.focus();
}
