// The React side of `overlayStack`: register while open, unregister on close,
// and tell layers opened from inside this one who their parent is.

import { createContext, useContext, useEffect, useRef, useState, type RefObject } from "react";
import { pushOverlay, type OverlayLayer } from "./overlayStack";

/**
 * The layer the surrounding tree belongs to. A component that hosts other
 * overlays (`Modal`, a panel drawn over one) provides its own layer here, so a
 * list or a dialog opened inside it knows what it sits on.
 */
export const OverlayParentContext = createContext<OverlayLayer | null>(null);

interface Options {
  /** Keep Tab inside this layer. For dialogs; lists and pickers leave it alone. */
  trapsFocus?: boolean;
  /** The element focus returns to when a layer opened above this one closes. */
  elementRef?: RefObject<HTMLElement | null>;
}

/**
 * Be one layer of the overlay stack while `open`.
 *
 * `onEscape` runs when Escape is pressed and this layer is the topmost; the
 * latest one is always used, so callers need not memoise it. The returned
 * layer is stable for the component's lifetime: pass it to
 * `OverlayParentContext` when other overlays can open from inside.
 */
export function useOverlayLayer(open: boolean, onEscape: () => void, options: Options = {}): OverlayLayer {
  const parent = useContext(OverlayParentContext);
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  const { elementRef } = options;
  const [layer] = useState<OverlayLayer>(() => ({
    onEscape: () => escapeRef.current(),
    trapsFocus: options.trapsFocus ?? false,
    parent,
    element: () => elementRef?.current ?? null,
  }));

  useEffect(() => {
    if (!open) return;
    return pushOverlay(layer);
  }, [open, layer]);

  return layer;
}
