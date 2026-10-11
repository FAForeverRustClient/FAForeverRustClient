// One stack for everything that floats over the page and closes on Escape:
// dialogs, panels drawn over a dialog, and the lists and pickers that drop
// down inside either.
//
// Each of these used to listen for Escape on its own, so stacking two meant
// one press closed both: the Generate Map dialog and the Host Game dialog
// under it, or a filter list and the replay panel it sat in. Every screen
// that hit this grew its own workaround (a capture-phase listener here, a
// `stopPropagation` on the window there), and the workarounds raced each
// other by registration order. Here there is one listener, and it hands
// Escape to the topmost layer only. The next press reaches the next layer.
//
// The listener sits on `<html>` in the bubble phase, after React has run the
// handlers of whatever has focus and before any listener on `document` or
// `window`. That order is deliberate on both sides:
//
// - A field that gives Escape a meaning of its own (abandoning a rename,
//   cancelling an inline edit) still gets it first, and keeps it by calling
//   `stopPropagation`, which is how those fields already opted out of the old
//   `Modal` handler.
// - Older popovers that still listen on `document` or `window` are not reached
//   at all while a layer is open, so a menu under a dialog no longer closes
//   along with the dialog's own list.
//
// Layers are pure data here; `useOverlayLayer` is the React side.

export interface OverlayLayer {
  /** What Escape does when this layer is the topmost one. */
  onEscape: () => void;
  /**
   * Whether this layer keeps Tab inside itself. Only the topmost such layer
   * does; a list open inside a dialog takes Escape but not the focus trap.
   */
  trapsFocus: boolean;
  /**
   * The layer this one was opened from, as React's tree knows it. Used only to
   * order two layers that register in the same commit, where effects run
   * child first and would otherwise put the parent on top.
   */
  parent: OverlayLayer | null;
  /** Where focus goes when the layer above this one closes and has nowhere better. */
  element?: () => HTMLElement | null;
}

/** The subset of a `KeyboardEvent` the stack reads, so tests need no DOM. */
export interface OverlayKeyEvent {
  key: string;
  isComposing?: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

function descendsFrom(layer: OverlayLayer, ancestor: OverlayLayer): boolean {
  for (let current = layer.parent; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

export function createOverlayStack() {
  const layers: OverlayLayer[] = [];

  return {
    /**
     * Put a layer on the stack and return what takes it off again.
     *
     * Normally on top. A layer that something already on the stack was opened
     * from goes underneath that child instead, which is the same-commit case
     * `parent` exists for.
     */
    push(layer: OverlayLayer): () => void {
      const childIndex = layers.findIndex((existing) => descendsFrom(existing, layer));
      if (childIndex === -1) layers.push(layer);
      else layers.splice(childIndex, 0, layer);
      return () => {
        const index = layers.indexOf(layer);
        if (index !== -1) layers.splice(index, 1);
      };
    },

    top(): OverlayLayer | undefined {
      return layers[layers.length - 1];
    },

    /** The topmost layer that traps focus, which is the one Tab belongs to. */
    topFocusTrap(): OverlayLayer | undefined {
      for (let index = layers.length - 1; index >= 0; index -= 1) {
        if (layers[index].trapsFocus) return layers[index];
      }
      return undefined;
    },

    size(): number {
      return layers.length;
    },

    /**
     * Give Escape to the topmost layer. Returns whether it was taken.
     *
     * Taken even when that layer then does nothing with it, which is a
     * dialog that may not be dismissed: the press stops there rather than
     * falling through and closing whatever is underneath. Not while an input
     * method is composing, where Escape cancels the composition.
     */
    handleKey(event: OverlayKeyEvent): boolean {
      if (event.key !== "Escape" || event.isComposing) return false;
      const top = layers[layers.length - 1];
      if (!top) return false;
      event.preventDefault();
      event.stopPropagation();
      top.onEscape();
      return true;
    },
  };
}

export type OverlayStack = ReturnType<typeof createOverlayStack>;

/** The client's one stack. */
export const overlayStack = createOverlayStack();

let installed = false;

function install() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.documentElement.addEventListener("keydown", (event) => {
    overlayStack.handleKey(event);
  });
}

/** Register a layer with the client's stack; the result unregisters it. */
export function pushOverlay(layer: OverlayLayer): () => void {
  install();
  return overlayStack.push(layer);
}

/**
 * Put focus back where it was before a layer opened.
 *
 * Where that element has gone (it was inside a layer that closed in the same
 * pass, or its row was re-rendered away), the layer now on top takes focus
 * instead, so the caret stays inside the dialog that is still open rather than
 * dropping to the page behind it.
 */
export function restoreFocus(previous: HTMLElement | null) {
  if (previous?.isConnected) {
    previous.focus();
    return;
  }
  overlayStack.topFocusTrap()?.element?.()?.focus();
}
