// Vault reviews: read the community's verdict, and write your own.
//
// Mirrors the Java client's `ReviewsController`: an average with a star
// distribution at the top, your own review in an editable block, and
// everyone else's beneath. Opened from a map or mod's detail pane, and from
// a replay's stars.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { StatusNotice } from "../../design-system/StatusNotice";
import type { Review, ReviewKind, ReviewSummary } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { LoadStatusNotice } from "../../shared/components/LoadNotices";
import { plainError } from "../../shared/plainError";
import { useAppStore } from "../../store/store";
import { t, type MessageKey } from "../../i18n";
import "./reviews.css";
import { useTranslation } from "../../i18n/useTranslation";

const SCORES = [5, 4, 3, 2, 1];

const close = () => ipc.send({ kind: "Reviews", command: { type: "close" } });
const submit = (score: number, text: string) =>
  ipc.send({ kind: "Reviews", command: { type: "submit", payload: { score, text } } });
const remove = () => ipc.send({ kind: "Reviews", command: { type: "delete" } });

/** Twin of `own_review` in the domain: logins do not round-trip case-stably. */
function ownReview(reviews: Review[], login: string): Review | null {
  if (!login) return null;
  return reviews.find((r) => r.player.toLowerCase() === login.toLowerCase()) ?? null;
}

function Stars({ score, of = 5 }: { score: number; of?: number }) {
  const filled = Math.round(score);
  return (
    <span className="review-stars" aria-label={t("reviews.scoreAria", { score: score.toFixed(1), of })}>
      {Array.from({ length: of }, (_, index) => (
        <span key={index} className={index < filled ? "is-filled" : undefined} aria-hidden="true">
          ★
        </span>
      ))}
    </span>
  );
}

const HEADING = {
  map: "reviews.mapReviews",
  mod: "reviews.modReviews",
  game: "reviews.gameReviews",
} as const satisfies Record<ReviewKind, MessageKey>;

export function ReviewsPanel() {
  const { t } = useTranslation();
  const state = useAppStore((store) => store.state.reviews);
  const player = useAppStore((store) => store.state.auth.player);
  // A replay's reviews open on top of the replay panel, which is a `Modal`
  // too. One Escape used to shut both, so this took the key in the capture
  // phase; the overlay stack now gives it to the topmost layer only, which is
  // this `Modal` while it is open (or a list open inside it, first).
  if (state.target === null) return null;

  const mine = ownReview(state.reviews, player?.name ?? "");
  const others = state.reviews.filter((review) => review.id !== mine?.id);
  const target = state.target;
  // Opening the same target again is the whole retry: the service reloads
  // whatever it is asked to open, and the panel keeps its heading meanwhile.
  const retry = () => ipc.send({ kind: "Reviews", command: { type: "open", payload: { target } } });

  return (
    <Modal
      className="reviews-modal"
      // Named after what is being reviewed, as its heading is: "Dialog" said
      // nothing to somebody who could not see the heading.
      ariaLabel={t("reviews.dialogAria", { kind: t(HEADING[target.kind]), name: target.name })}
      onClose={() => void close()}
    >
      <header className="reviews-head">
        <div>
          <span className="reviews-eyebrow">
            {t(HEADING[target.kind])}
          </span>
          <h2>{target.name}</h2>
        </div>
      </header>

      {state.status.type === "loading" && <p className="muted">{t("reviews.loading")}</p>}
      {/* A way out beside the failure, and the failure said plainly: the raw
          reason stays on hover for a bug report. */}
      <LoadStatusNotice status={state.status} failed={t("reviews.loadFailed")} onRetry={retry} />

      {state.status.type === "ready" && (
        <>
          <Distribution summary={state.summary} />

          {player ? (
            <OwnReview mine={mine} />
          ) : (
            <p className="muted">{t("reviews.signIn")}</p>
          )}

          <section className="reviews-list">
            <h3>
              {others.length === 0
                ? t("reviews.noOthers")
                : t("reviews.otherReviews", { count: others.length })}
            </h3>
            {others.map((review) => (
              <article className="surface review-row" key={review.id}>
                <header>
                  <strong>{review.player || t("reviews.unknownPlayer")}</strong>
                  <Stars score={review.score} />
                  {review.version && (
                    <small className="muted">{t("reviews.version", { version: review.version })}</small>
                  )}
                </header>
                {review.text && <p>{review.text}</p>}
              </article>
            ))}
          </section>
        </>
      )}
    </Modal>
  );
}

function Distribution({ summary }: { summary: ReviewSummary }) {
  const { t } = useTranslation();
  return (
    <section className="reviews-summary">
      <div className="reviews-average">
        <strong>{summary.total === 0 ? "N/A" : (summary.averageTenths / 10).toFixed(1)}</strong>
        <Stars score={summary.averageTenths / 10} />
        <small className="muted">{t("reviews.count", { count: summary.total })}</small>
      </div>
      <div className="reviews-bars">
        {SCORES.map((score) => {
          const count = summary.counts[score - 1] ?? 0;
          // Guarded the same way both reference clients guard it: an
          // unreviewed subject would otherwise divide by zero.
          const percent = summary.total === 0 ? 0 : (count / summary.total) * 100;
          return (
            <div className="reviews-bar" key={score}>
              <span className="reviews-bar-label">{score}★</span>
              <span className="reviews-bar-track">
                <span className="reviews-bar-fill" style={{ width: `${percent}%` }} />
              </span>
              <span className="reviews-bar-count muted">{count}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function OwnReview({ mine }: { mine: Review | null }) {
  const { t } = useTranslation();
  const submitStatus = useAppStore((store) => store.state.reviews.submit);
  const [score, setScore] = useState(mine?.score ?? 5);
  const [text, setText] = useState(mine?.text ?? "");

  // Adopt the server's version of our review once a write settles, so the
  // editor is not left showing something subtly different from what everyone
  // else can see.
  useEffect(() => {
    setScore(mine?.score ?? 5);
    setText(mine?.text ?? "");
  }, [mine?.id, mine?.score, mine?.text]);

  const saving = submitStatus.type === "saving";

  return (
    <section className="surface reviews-own">
      <h3>{t(mine ? "reviews.yours" : "reviews.write")}</h3>

      <div className="reviews-score-picker" role="group" aria-label={t("reviews.yourScore")}>
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            type="button"
            key={value}
            className={value <= score ? "reviews-score is-on" : "reviews-score"}
            aria-pressed={value === score}
            aria-label={t("reviews.starsAria", { count: value })}
            onClick={() => setScore(value)}
          >
            ★
          </button>
        ))}
      </div>

      <textarea
        className="reviews-text"
        value={text}
        maxLength={2000}
        rows={4}
        placeholder={t("reviews.placeholder")}
        onChange={(event) => setText(event.target.value)}
      />

      <div className="reviews-own-actions">
        <Button variant="primary" disabled={saving} onClick={() => void submit(score, text)}>
          {t(saving ? "reviews.saving" : mine ? "reviews.update" : "reviews.post")}
        </Button>
        {mine && (
          <Button disabled={saving} onClick={() => void remove()}>
            <Icon name="close" size={14} /> {t("reviews.withdraw")}
          </Button>
        )}
      </div>

      {/* Retry sends what the editor holds now, which is what the reader
          expects a second press of the button above to send too. */}
      {submitStatus.type === "failed" && (
        <StatusNotice
          tone="error"
          action={{ label: t("common.retry"), onClick: () => void submit(score, text) }}
          detail={submitStatus.payload.reason}
        >
          {t("reviews.saveFailed")}: {plainError(submitStatus.payload.reason)}
        </StatusNotice>
      )}
      {submitStatus.type === "saved" && <p className="reviews-submit is-ok">{t("reviews.saved")}</p>}
    </section>
  );
}
