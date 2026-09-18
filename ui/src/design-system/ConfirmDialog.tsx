// A question with two answers: the thing the user asked for, and not.
//
// One component for every "are you sure" in the client, so they all put the
// destructive action on the right in the same red, the cancel in the same
// place, and the sentence that says what cannot be undone in the same tone.
// Before this each vault wrote its own, and the two had already drifted: one
// had its body sentence hardcoded in English while the other was translated.
//
// Not for dialogs that collect something (a reason, a name): those are forms
// and own their layout; this is a message and two buttons.

import type { ReactNode } from "react";

import { useTranslation } from "../i18n/useTranslation";
import { Button } from "./Button";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
  title: string;
  /** The sentence under the title: what is about to happen, and to what. */
  body: ReactNode;
  /** What cannot be undone afterwards, when there is such a thing. */
  warning?: ReactNode;
  confirmLabel: string;
  /** Defaults to the client's one "Cancel". */
  cancelLabel?: string;
  /** Red confirm for a destructive answer; the primary accent otherwise. */
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  warning,
  confirmLabel,
  cancelLabel,
  danger = false,
  disabled = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  return (
    <Modal className="confirm-modal" onClose={onCancel} ariaLabel={title}>
      <div className="confirm-dialog-content">
        <h2>{title}</h2>
        <p>{body}</p>
        {warning && <p className="confirm-dialog-warning">{warning}</p>}
        <div className="confirm-dialog-actions">
          <Button onClick={onCancel}>{cancelLabel ?? t("common.cancel")}</Button>
          <Button variant={danger ? "danger" : "primary"} disabled={disabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
