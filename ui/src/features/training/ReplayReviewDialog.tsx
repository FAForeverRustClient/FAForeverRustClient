// Requesting a replay review.
//
// Everything above the two questions arrived prefilled from state the client
// already had: the replay and its link, the map, the mode, the faction, the
// rating this account had in that game. The fields are still editable, because
// the client is occasionally wrong about which player in a game is the one
// asking, and a form that could not be corrected would be worse than a blank
// one.
//
// The two questions at the bottom are the ones nobody else can answer, and the
// first is required: a request that does not say what help is wanted is the
// single most common reason a review sits unanswered.

import { useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import type { ForumPost, ReviewRequestDraft } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { PostPreview } from "./PostPreview";
import { reviewProblem } from "../../shared/rules/trainingRules";
import { reviewProblemLabel } from "./trainingPresentation";
import {
  forgetReview,
  keepReview,
  keptReview,
  replayReference,
  reviewKey,
  sameReview,
  withReplay,
} from "./reviewDraft";

interface Props {
  /** The prefilled draft the service opened the form with. */
  prefilled: ReviewRequestDraft;
  post: ForumPost | null;
  onCompose: (draft: ReviewRequestDraft) => void;
  onClose: () => void;
}

export function ReplayReviewDialog({ prefilled, post, onCompose, onClose }: Props) {
  const { t } = useTranslation();
  // The form owns the draft while it is being typed. Pushing every keystroke
  // through the backend would put an IPC round trip between a key and the
  // character appearing, which for a controlled field is how typed characters
  // get dropped.
  //
  // It starts from what was kept for this game, if the dialog was closed on
  // it before (Escape, a click beside it), and from the service's prefill
  // otherwise.
  const [draftKey, setDraftKey] = useState(() => reviewKey(prefilled));
  const [draft, setDraft] = useState(() => keptReview(reviewKey(prefilled)) ?? prefilled);
  // The prefill is taken once per opened request, never again while the
  // player types. The state answers every Compose with the composed draft as
  // a new object, and adopting that echo replaced whatever was typed while it
  // travelled. Only a draft that is neither the prefill already taken nor
  // what this form sent is a different request, and replaces the fields.
  // A composed post describes the draft as it was. Editing after composing
  // makes it stale, and showing it would let the player post the version they
  // just changed away from.
  const [stale, setStale] = useState(false);
  const adopted = useRef<ReviewRequestDraft>(prefilled);
  const sent = useRef<ReviewRequestDraft | null>(null);
  useEffect(() => {
    if (sameReview(prefilled, adopted.current) || sameReview(prefilled, sent.current)) return;
    adopted.current = prefilled;
    sent.current = null;
    const next = reviewKey(prefilled);
    setDraftKey(next);
    setDraft(keptReview(next) ?? prefilled);
    setStale(false);
  }, [prefilled]);
  const onChange = (next: ReviewRequestDraft) => {
    setDraft(next);
    setStale(true);
    keepReview(draftKey, next);
  };
  const problem = reviewProblem(draft);

  const field = (
    key: keyof ReviewRequestDraft,
    label: string,
    options: { placeholder?: string; readOnly?: boolean } = {},
  ) => (
    <label className="training-field">
      <span>{label}</span>
      <input
        value={String(draft[key] ?? "")}
        onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
        placeholder={options.placeholder}
        readOnly={options.readOnly}
      />
    </label>
  );

  return (
    <Modal onClose={onClose} ariaLabel={t("training.review.title")} className="training-dialog">
      <form
        className="training-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (problem) return;
          sent.current = draft;
          keepReview(draftKey, draft);
          onCompose(draft);
          setStale(false);
        }}
      >
        <h4>{t("training.review.title")}</h4>
        <p className="muted">{t("training.review.lead")}</p>

        <div className="training-field-grid">
          <label className="training-field is-wide">
            <span>{t("training.review.replay")}</span>
            <input
              value={replayReference(draft)}
              onChange={(event) => onChange(withReplay(draft, event.target.value))}
              placeholder={t("training.review.replayPlaceholder")}
            />
          </label>
          {field("player", t("training.review.player"))}
          {/* A text field rather than a number one: a number input is empty for
              a keystroke while it is being retyped, and modelling that as a
              number means either a zero or a field that fights the user. */}
          {field("rating", t("training.review.rating"), { placeholder: "1150" })}
          {field("gameMode", t("training.review.mode"), { placeholder: "1v1" })}
          {field("map", t("training.review.map"))}
          {field("faction", t("training.review.faction"))}
          {field("playedAt", t("training.review.played"))}
        </div>

        <label className="training-field">
          <span>
            {t("training.review.goal")} <em>{t("training.required")}</em>
          </span>
          <textarea
            value={draft.goal}
            onChange={(event) => onChange({ ...draft, goal: event.target.value })}
            placeholder={t("training.review.goalPlaceholder")}
            rows={3}
            autoFocus
          />
        </label>

        <label className="training-field">
          <span>{t("training.review.struggle")}</span>
          <textarea
            value={draft.struggle}
            onChange={(event) => onChange({ ...draft, struggle: event.target.value })}
            placeholder={t("training.review.strugglePlaceholder")}
            rows={3}
          />
        </label>

        {problem && (
          <p className="muted training-form-problem">{t(reviewProblemLabel(problem))}</p>
        )}

        <div className="training-form-actions">
          <Button type="submit" variant="primary" disabled={problem !== null}>
            <Icon name="edit" size={15} /> {t("training.review.compose")}
          </Button>
          {/* Cancel is the one deliberate way to throw the draft away.
              Escape and a click beside the dialog keep it for next time. */}
          <Button
            onClick={() => {
              forgetReview(draftKey);
              onClose();
            }}
          >
            {t("common.cancel")}
          </Button>
        </div>

        {post && !stale && (
          <PostPreview
            post={post}
            destination="discord"
            // Copied out to be posted is as finished as this request gets
            // inside the client, so the kept draft goes. Typing again keeps
            // it again.
            onDelivered={() => forgetReview(draftKey)}
          />
        )}
      </form>
    </Modal>
  );
}
