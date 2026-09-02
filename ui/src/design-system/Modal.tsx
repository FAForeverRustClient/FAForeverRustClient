// Modal primitive: overlay + centered panel, no animation library (matches
// the plain-CSS approach the rest of this design system uses). Closes on a
// backdrop click that starts and ends on the backdrop, or the close button;
// callers own open/closed state.

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import "./modal.css";
import { useTranslation } from "../i18n/useTranslation";

interface ModalProps {
  onClose: () => void;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
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

export function Modal({ onClose, children, className, ariaLabel }: ModalProps) {
  const { t } = useTranslation();
  // Most callers rely on this default for the dialog's accessible name.
  const label = ariaLabel ?? t("designSystem.modal.dialog");
  const panelRef = useRef<HTMLDivElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

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
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow || "hidden";
      previousFocus?.focus();
    };
  }, []);

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
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

  return (
    <div
      className="modal-backdrop"
      onPointerDown={(event) => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const started = pressStartedOnBackdrop.current;
        pressStartedOnBackdrop.current = false;
        if (isBackdropDismissal(started, event.target === event.currentTarget)) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={className ? `modal-panel ${className}` : "modal-panel"}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={trapFocus}
      >
        <button type="button" className="modal-close" onClick={onClose} aria-label={t("common.close")}>
          ×
        </button>
        {children}
      </div>
    </div>
  );
}
