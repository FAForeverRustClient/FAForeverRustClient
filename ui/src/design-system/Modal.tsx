// Modal primitive: overlay + centered panel, no animation library (matches
// the plain-CSS approach the rest of this design system uses). Closes on a
// backdrop click that starts and ends on the backdrop, the close button, or
// Escape; callers own open/closed state.
//
// Escape and the focus trap go through the overlay stack, so a dialog opened
// from another one (Generate Map over Host Game, an uninstall confirmation, a
// map preview) is the only one a press of Escape closes, and the only one Tab
// is kept inside. Anything that opens over a modal, a list or a panel drawn on
// top, registers with the same stack and is closed before the modal is.

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./modal.css";
import { useTranslation } from "../i18n/useTranslation";
import { overlayStack, restoreFocus } from "./overlayStack";
import { OverlayParentContext, useOverlayLayer } from "./useOverlayLayer";

interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  /**
   * Whether the user may close this dialog at all. Default `true`.
   *
   * `false` removes the three ways out - the close button, Escape and a
   * backdrop click - rather than leaving them there to do nothing, which
   * is how a dialog comes to look broken. It is for the rare dialog that
   * is a gate rather than a question: something the client genuinely
   * cannot carry on past. Everything else stays dismissible.
   */
  dismissible?: boolean;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/// The same set, minus the dialog's own close button: what a caller would
/// consider the first control of *their* dialog. Tab order still includes the
/// close button; this only decides where the caret starts.
const CONTENT_FOCUSABLE = FOCUSABLE.split(",")
  .map((selector) => `${selector}:not(.modal-close)`)
  .join(",");

/// Whether a backdrop click should dismiss the dialog.
///
/// A click event is delivered to the nearest common ancestor of where the
/// press started and where it ended. Marking the lobby name in the host
/// dialog and releasing the button outside the panel therefore lands a click
/// on the backdrop itself, and dismissing on that alone closed the dialog
/// under the player mid-selection, losing everything they had filled in.
/// Only a gesture that both began and ended on the backdrop is a dismissal.
export function isBackdropDismissal(pressStartedOnBackdrop: boolean, releasedOnBackdrop: boolean): boolean {
  return pressStartedOnBackdrop && releasedOnBackdrop;
}

export function Modal({
  onClose,
  children,
  className,
  ariaLabel,
  dismissible = true,
}: ModalProps) {
  const { t } = useTranslation();
  // Most callers rely on this default for the dialog's accessible name.
  const label = ariaLabel ?? t("designSystem.modal.dialog");
  const panelRef = useRef<HTMLDivElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  // Registered before the focus effect below so it is also unregistered
  // before that effect's cleanup runs: by the time focus is restored, the
  // layer underneath is already the top one and can take it.
  //
  // A dialog that may not be dismissed still takes Escape, and does nothing
  // with it, so the press cannot fall through and close what is underneath.
  const layer = useOverlayLayer(
    true,
    () => {
      if (dismissibleRef.current) closeRef.current();
    },
    { trapsFocus: true, elementRef: panelRef },
  );

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    // The close button is the first control in the DOM, so focusing "the first
    // control" put the caret on it and every keystroke went nowhere: a dialog
    // whose text field looked ready but silently ignored typing. A field the
    // caller marked `autoFocus` wins, then any other control, and the close
    // button only as a last resort.
    const requested = panel?.querySelector<HTMLElement>("[autofocus]");
    const firstControl = panel?.querySelector<HTMLElement>(CONTENT_FOCUSABLE);
    const fallback = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (requested ?? firstControl ?? fallback ?? panel)?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow || "hidden";
      restoreFocus(previousFocus);
    };
  }, []);

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    // React events bubble through portals along the component tree, so a Tab
    // inside a dialog opened from this one arrives here too. Only the topmost
    // dialog decides where Tab goes.
    if (overlayStack.topFocusTrap() !== layer) return;
    const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter((element) => element.offsetParent !== null);
    if (controls.length === 0) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Escape from inside the panel is settled here rather than left to the
    // stack's document-level listener. React carries a key event up the
    // component tree, through portals, so without this a handler on whatever
    // rendered the dialog would see the same press after the field inside had
    // had its say. The stack still decides which layer it goes to.
    if (event.key === "Escape") {
      overlayStack.handleKey({
        key: event.key,
        isComposing: event.nativeEvent.isComposing,
        preventDefault: () => event.preventDefault(),
        stopPropagation: () => event.stopPropagation(),
      });
      return;
    }
    trapFocus(event);
  };

  const dialog = (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const started = pressStartedOnBackdrop.current;
        pressStartedOnBackdrop.current = false;
        if (dismissible && isBackdropDismissal(started, event.target === event.currentTarget)) {
          onClose();
        }
      }}
    >
      <div
        ref={panelRef}
        className={className ? `modal-panel ${className}` : "modal-panel"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
      >
        {dismissible && (
          <button
            type="button"
            className="modal-close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            ×
          </button>
        )}
        <OverlayParentContext.Provider value={layer}>{children}</OverlayParentContext.Provider>
      </div>
    </div>
  );

  // Into `document.body`, not where the caller happens to sit.
  //
  // `position: fixed` with a `z-index` is only fixed and only ordered relative
  // to its own stacking context, and callers open dialogs from inside panels
  // that have one: `.vault-detail-panel` is `position: sticky`, which creates
  // a stacking context whatever its z-index is. A dialog opened from there was
  // ordered against its panel's siblings rather than against the page, so a
  // FEATURED badge on a card in the results grid -- `z-index: 1`, a hundred
  // less than the backdrop -- painted over it.
  //
  // Nothing depends on where a modal sits in the DOM: every rule for one
  // targets `.modal-backdrop` or `.modal-panel` directly rather than through
  // an ancestor, and React events still bubble through the React tree, so a
  // caller's handlers are unaffected.
  //
  // Inline when there is no document, which is `renderToStaticMarkup` in the
  // tests: the server renderer cannot render a portal at all.
  return typeof document === "undefined" ? dialog : createPortal(dialog, document.body);
}
