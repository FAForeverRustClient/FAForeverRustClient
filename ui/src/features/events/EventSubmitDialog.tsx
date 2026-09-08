// The submission form: what the catalogue needs, asked once.
//
// It exists so that nobody has to know the document format. The player fills in
// what they know in their own time zone, and the button opens a GitHub issue
// that already contains the finished catalogue entry, in a block the bot in the
// catalogue repository commits without anybody retyping it.
//
// The client does not post the issue. It has no GitHub identity, and the last
// step being the player's own click is also what keeps a submission attributable
// to the person making it.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { useTranslation } from "../../i18n/useTranslation";
import { openHttpsUrl } from "../../shared/externalLinks";
import type { EventCategory, EventOrigin } from "../../ipc/bindings";
import { CATEGORIES, categoryLabel } from "./eventPresentation";
import {
  EMPTY_DRAFT,
  submissionBlock,
  submissionIssueUrl,
  submissionProblem,
  type DraftRecurrence,
  type EventDraft,
} from "./eventSubmission";

const RECURRENCES: DraftRecurrence[] = ["none", "weekly", "fortnightly", "monthly"];

interface Props {
  /** The catalogue's own submission address. */
  submitUrl: string;
  onClose: () => void;
}

export function EventSubmitDialog({ submitUrl, onClose }: Props) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<EventDraft>(EMPTY_DRAFT);
  const set = (change: Partial<EventDraft>) => setDraft((current) => ({ ...current, ...change }));

  const problem = submissionProblem(draft);
  const url = problem === null ? submissionIssueUrl(submitUrl, draft) : null;

  return (
    <Modal className="event-submit-modal" onClose={onClose} ariaLabel={t("events.submit.title")}>
      <h2>{t("events.submit.title")}</h2>
      <p className="event-submit-intro">{t("events.submit.intro")}</p>

      <div className="event-submit-form">
        <label className="event-submit-wide">
          <span>{t("events.submit.name")}</span>
          <input
            type="text"
            value={draft.title}
            onChange={(change) => set({ title: change.target.value })}
            placeholder={t("events.submit.namePlaceholder")}
          />
        </label>

        <label>
          <span>{t("events.submit.day")}</span>
          <input
            type="date"
            value={draft.day}
            onChange={(change) => set({ day: change.target.value })}
          />
        </label>
        <label>
          <span>{t("events.submit.time")}</span>
          <input
            type="time"
            value={draft.time}
            onChange={(change) => set({ time: change.target.value })}
          />
        </label>
        <label>
          <span>{t("events.submit.endTime")}</span>
          <input
            type="time"
            value={draft.endTime}
            disabled={draft.time.trim() === ""}
            onChange={(change) => set({ endTime: change.target.value })}
          />
        </label>

        <label>
          <span>{t("events.submit.category")}</span>
          <select
            value={draft.category}
            onChange={(change) => set({ category: change.target.value as EventCategory })}
          >
            {CATEGORIES.map((category) => (
              <option key={category} value={category}>{t(categoryLabel(category))}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("events.submit.origin")}</span>
          <select
            value={draft.origin}
            onChange={(change) => set({ origin: change.target.value as EventOrigin })}
          >
            <option value="community">{t("events.origin.community")}</option>
            <option value="official">{t("events.origin.official")}</option>
          </select>
        </label>
        <label>
          <span>{t("events.submit.recurrence")}</span>
          <select
            value={draft.recurrence}
            onChange={(change) => set({ recurrence: change.target.value as DraftRecurrence })}
          >
            {RECURRENCES.map((option) => (
              <option key={option} value={option}>{t(`events.submit.recurrence.${option}`)}</option>
            ))}
          </select>
        </label>

        <label>
          <span>{t("events.submit.host")}</span>
          <input
            type="text"
            value={draft.host}
            onChange={(change) => set({ host: change.target.value })}
            placeholder={t("events.submit.hostPlaceholder")}
          />
        </label>
        <label className="event-submit-wide">
          <span>{t("events.submit.summary")}</span>
          <textarea
            rows={2}
            value={draft.summary}
            onChange={(change) => set({ summary: change.target.value })}
            placeholder={t("events.submit.summaryPlaceholder")}
          />
        </label>

        <label>
          <span>{t("events.submit.linkLabel")}</span>
          <input
            type="text"
            value={draft.linkLabel}
            onChange={(change) => set({ linkLabel: change.target.value })}
            placeholder={t("events.submit.linkLabelPlaceholder")}
          />
        </label>
        <label className="event-submit-wide">
          <span>{t("events.submit.linkUrl")}</span>
          <input
            type="url"
            value={draft.linkUrl}
            onChange={(change) => set({ linkUrl: change.target.value })}
            placeholder="https://discord.gg/..."
          />
        </label>
      </div>

      {/* The entry itself, shown rather than hidden. Somebody who knows the
          format can check it before pressing the button, and somebody who does
          not can see that the client did the work. */}
      <details className="event-submit-preview">
        <summary>{t("events.submit.preview")}</summary>
        <pre>{submissionBlock(draft)}</pre>
      </details>

      <p className="event-submit-explain muted">{t("events.submit.explain")}</p>

      {problem && <p className="event-submit-problem" role="alert">{t(problem)}</p>}

      <div className="event-submit-actions">
        <Button onClick={onClose}>{t("common.cancel")}</Button>
        <Button
          variant="primary"
          disabled={url === null}
          onClick={() => {
            if (url === null) return;
            void openHttpsUrl(url);
            onClose();
          }}
        >
          <Icon name="external" size={14} /> {t("events.submit.open")}
        </Button>
      </div>
    </Modal>
  );
}
