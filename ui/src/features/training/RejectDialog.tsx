// Declining a submission, with a reason.
//
// The reason is required and comes from a closed set, because it is written
// into the repository where the author reads it. "No" without a category is
// the feedback that makes people stop submitting, and a free-text box alone
// invites either nothing or an essay.
//
// The note is optional and is the part that actually helps: which fact was
// wrong, which existing guide already covers it.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type { GuideSubmission, RejectReason } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";

/** Twin of `RejectReason::ALL`, in the order the dialog offers them. */
const REASONS: RejectReason[] = [
  "duplicate",
  "incorrectInformation",
  "poorQuality",
  "outdated",
  "wrongCategorisation",
];

interface Props {
  submission: GuideSubmission;
  onConfirm: (reason: RejectReason, note: string) => void;
  onClose: () => void;
}

export function RejectDialog({ submission, onConfirm, onClose }: Props) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<RejectReason | null>(null);
  const [note, setNote] = useState("");

  return (
    <Modal onClose={onClose} ariaLabel={t("training.reject.title")} className="training-dialog">
      <form
        className="training-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (reason) onConfirm(reason, note);
        }}
      >
        <h4>{t("training.reject.title")}</h4>
        <p className="muted">{t("training.reject.lead", { title: submission.title })}</p>

        <fieldset className="training-reasons">
          <legend>
            {t("training.reject.reason")} <em>{t("training.required")}</em>
          </legend>
          {REASONS.map((candidate) => (
            <label key={candidate} className="training-reason">
              <input
                type="radio"
                name="reject-reason"
                checked={reason === candidate}
                onChange={() => setReason(candidate)}
              />
              <span>{t(`training.reject.reason.${candidate}`)}</span>
            </label>
          ))}
        </fieldset>

        <label className="training-field">
          <span>{t("training.reject.note")}</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder={t("training.reject.notePlaceholder")}
            rows={3}
          />
        </label>

        <div className="training-form-actions">
          <Button type="submit" variant="primary" disabled={reason === null}>
            <Icon name="close" size={15} /> {t("training.reject.confirm")}
          </Button>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
        </div>
      </form>
    </Modal>
  );
}
