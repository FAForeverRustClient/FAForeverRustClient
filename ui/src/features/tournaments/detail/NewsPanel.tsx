// The organiser's announcements.
//
// Its own section rather than a banner, because these are the things that
// change a player's evening: a start time moved, a round delayed, a map pool
// swapped. Important posts are marked by the organiser rather than inferred
// from age, so a three-day-old "we start an hour later" still reads as urgent
// on the day.
//
// Drawn as a timeline, newest first: a rail down the left with a point per
// post, the newest one lit and an important one in the warn colour, and each
// post a card with who wrote it and when over the text. The text is the
// website's markdown, as everywhere else an organiser writes, so it goes
// through `RichText` like the briefing does.

import { useState } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type { Tourney } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { formatMoment } from "../tourneyPresentation";
import type { NewsActions } from "../tourneyActions";
import { RichText } from "./RichText";

interface NewsPanelProps {
  event: Tourney;
  busy: boolean;
  /** Where the service lives, for the images a post places. */
  assetBase: string;
  news: Pick<NewsActions, "post" | "edit" | "remove">;
}

export function NewsPanel({ event, busy, assetBase, news }: NewsPanelProps) {
  const { t } = useTranslation();
  /** Bumped after a post, which hands the composer back empty. */
  const [composerKey, setComposerKey] = useState(0);
  /** The post being corrected, if any. */
  const [editing, setEditing] = useState<{ id: string; body: string; important: boolean } | null>(
    null,
  );
  const organiser = event.viewer.organiser;

  return (
    <div className="tournament-news">
      {organiser && (
        <NewsComposer
          key={composerKey}
          title={t("tournaments.news.compose")}
          initial={{ body: "", important: false }}
          busy={busy}
          assetBase={assetBase}
          submitLabel={t("tournaments.news.post")}
          onSubmit={(draft) => {
            news.post(draft.body, draft.important);
            // A fresh composer, empty, for the next post.
            setComposerKey((held) => held + 1);
          }}
        />
      )}

      {event.news.length === 0 ? (
        <section className="tournament-panel">
          <p className="muted">{t("tournaments.news.none")}</p>
        </section>
      ) : (
        <ol className="tournament-news-feed">
          {event.news.map((post, index) => (
            <li
              key={post.id}
              className={[
                "tournament-news-entry",
                index === 0 ? "is-latest" : "",
                post.important ? "is-important" : "",
              ]
                .filter((name) => name !== "")
                .join(" ")}
            >
              <span className="tournament-news-dot" aria-hidden />
              <article className="tournament-panel tournament-news-card">
                <header className="tournament-news-head">
                  <div className="tournament-news-meta">
                    <span className="tournament-news-by">{post.by}</span>
                    {post.at !== null && (
                      <time dateTime={new Date(post.at * 1000).toISOString()}>{formatMoment(post.at, "")}</time>
                    )}
                    {/* A post that has itself been corrected is worth
                        flagging: the thing these announce is usually a
                        schedule, and a schedule that changed twice is not the
                        same news. */}
                    {post.editedAt !== null && <span>{t("tournaments.news.edited")}</span>}
                  </div>
                  {post.important && (
                    <span className="tournament-news-flag">{t("tournaments.news.importantBadge")}</span>
                  )}
                  {organiser && editing?.id !== post.id && (
                    <div className="tournament-news-tools">
                      <button
                        type="button"
                        className="tournaments-icon-button"
                        disabled={busy}
                        title={t("tournaments.news.edit")}
                        aria-label={t("tournaments.news.edit")}
                        onClick={() => setEditing({ id: post.id, body: post.body, important: post.important })}
                      >
                        <Icon name="edit" size={14} />
                      </button>
                      <button
                        type="button"
                        className="tournaments-icon-button is-danger"
                        disabled={busy}
                        title={t("tournaments.news.remove")}
                        aria-label={t("tournaments.news.remove")}
                        onClick={() => news.remove(post.id)}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </div>
                  )}
                </header>
                {editing?.id === post.id ? (
                  <NewsComposer
                    initial={{ body: editing.body, important: editing.important }}
                    busy={busy}
                    assetBase={assetBase}
                    submitLabel={t("tournaments.news.save")}
                    onCancel={() => setEditing(null)}
                    onSubmit={(draft) => {
                      news.edit(editing.id, draft.body, draft.important);
                      setEditing(null);
                    }}
                  />
                ) : (
                  <RichText source={post.body} assetBase={assetBase} className="is-document" />
                )}
              </article>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** What a post says and whether it is flagged. */
interface NewsDraft {
  body: string;
  important: boolean;
}

const NEWS_MAX = 1000;

/**
 * Writing a post, new or corrected: the text in a framed editor with its
 * length and the important flag along its foot, and under it the post as it
 * will read, once there is something to read.
 */
function NewsComposer({
  title,
  initial,
  busy,
  assetBase,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  /** A heading, for the new post; a correction sits inside its own card. */
  title?: string;
  initial: NewsDraft;
  busy: boolean;
  assetBase: string;
  submitLabel: string;
  onSubmit: (draft: NewsDraft) => void;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(initial);
  const ready = draft.body.trim() !== "";
  return (
    <form
      className={title !== undefined ? "tournament-panel tournament-news-compose" : "tournament-news-compose is-inline"}
      onSubmit={(submitted) => {
        submitted.preventDefault();
        if (!ready) return;
        onSubmit({ body: draft.body, important: draft.important });
      }}
    >
      {title !== undefined && <h4>{title}</h4>}
      <div className={draft.important ? "tournament-news-editor is-important" : "tournament-news-editor"}>
        <textarea
          value={draft.body}
          autoFocus={onCancel !== undefined}
          rows={onCancel !== undefined ? 5 : 4}
          maxLength={NEWS_MAX}
          aria-label={title ?? t("tournaments.news.compose")}
          placeholder={t("tournaments.news.placeholder")}
          onChange={(changed) => setDraft({ ...draft, body: changed.target.value })}
        />
        <div className="tournament-news-editor-foot">
          <button
            type="button"
            className={draft.important ? "tournament-news-flag-toggle is-on" : "tournament-news-flag-toggle"}
            aria-pressed={draft.important}
            onClick={() => setDraft({ ...draft, important: !draft.important })}
          >
            <Icon name="alert" size={14} /> {t("tournaments.news.important")}
          </button>
          <span className="tournament-news-count mono">
            {draft.body.length} / {NEWS_MAX}
          </span>
          <span className="tournament-news-buttons">
            {onCancel !== undefined && (
              <Button disabled={busy} onClick={onCancel}>
                {t("tournaments.news.cancel")}
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={busy || !ready}>
              <Icon name="check" size={14} /> {submitLabel}
            </Button>
          </span>
        </div>
      </div>
      {/* The post as it will read: the text is the website's markdown, and a
          link or a list is easier to get right while looking at it. */}
      {ready && (
        <div className="tournament-news-preview">
          <span className="tournament-news-preview-label">{t("tournaments.news.preview")}</span>
          <RichText source={draft.body} assetBase={assetBase} className="is-document" />
        </div>
      )}
    </form>
  );
}
