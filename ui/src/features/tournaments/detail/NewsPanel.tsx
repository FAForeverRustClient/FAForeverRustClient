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
  const [body, setBody] = useState("");
  const [important, setImportant] = useState(false);
  /** The post being corrected, if any. */
  const [editing, setEditing] = useState<{ id: string; body: string; important: boolean } | null>(
    null,
  );
  const organiser = event.viewer.organiser;

  return (
    <div className="tournament-news">
      {organiser && (
        <form
          className="tournament-panel tournament-news-compose"
          onSubmit={(submitted) => {
            submitted.preventDefault();
            if (body.trim() === "") return;
            news.post(body, important);
            setBody("");
            setImportant(false);
          }}
        >
          <h4>{t("tournaments.news.compose")}</h4>
          <textarea
            value={body}
            onChange={(changed) => setBody(changed.target.value)}
            rows={3}
            maxLength={1000}
            aria-label={t("tournaments.news.compose")}
            placeholder={t("tournaments.news.placeholder")}
          />
          <div className="tournament-news-actions">
            <label className="tournament-check">
              <input
                type="checkbox"
                checked={important}
                onChange={(changed) => setImportant(changed.target.checked)}
              />
              <span>{t("tournaments.news.important")}</span>
            </label>
            <Button type="submit" variant="primary" disabled={busy || body.trim() === ""}>
              {t("tournaments.news.post")}
            </Button>
          </div>
        </form>
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
                  <form
                    className="tournament-news-edit"
                    onSubmit={(submitted) => {
                      submitted.preventDefault();
                      if (editing.body.trim() === "") return;
                      news.edit(editing.id, editing.body, editing.important);
                      setEditing(null);
                    }}
                  >
                    <textarea
                      value={editing.body}
                      autoFocus
                      rows={4}
                      maxLength={1000}
                      aria-label={t("tournaments.news.compose")}
                      onChange={(changed) =>
                        setEditing((held) => (held === null ? held : { ...held, body: changed.target.value }))
                      }
                    />
                    <div className="tournament-news-actions">
                      <label className="tournament-check">
                        <input
                          type="checkbox"
                          checked={editing.important}
                          onChange={(changed) =>
                            setEditing((held) =>
                              held === null ? held : { ...held, important: changed.target.checked },
                            )
                          }
                        />
                        <span>{t("tournaments.news.important")}</span>
                      </label>
                      <div className="tournament-news-buttons">
                        <Button type="button" disabled={busy} onClick={() => setEditing(null)}>
                          {t("tournaments.news.cancel")}
                        </Button>
                        <Button type="submit" variant="primary" disabled={busy || editing.body.trim() === ""}>
                          {t("tournaments.news.save")}
                        </Button>
                      </div>
                    </div>
                  </form>
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
