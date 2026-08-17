// The organiser's announcements.
//
// Its own section rather than a banner, because these are the things that
// change a player's evening: a start time moved, a round delayed, a map pool
// swapped. Important posts are marked by the organiser rather than inferred
// from age, so a three-day-old "we start an hour later" still reads as urgent
// on the day.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import type { Tourney } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { formatMoment } from "./tourneyPresentation";

interface NewsPanelProps {
  event: Tourney;
  busy: boolean;
  onPost: (body: string, important: boolean) => void;
  onDelete: (newsId: string) => void;
}

export function NewsPanel({ event, busy, onPost, onDelete }: NewsPanelProps) {
  const { t } = useTranslation();
  const [body, setBody] = useState("");
  const [important, setImportant] = useState(false);
  const organiser = event.viewer.organiser;

  return (
    <div className="tournament-news">
      {organiser && (
        <form
          className="tournament-news-compose"
          onSubmit={(submitted) => {
            submitted.preventDefault();
            if (body.trim() === "") return;
            onPost(body, important);
            setBody("");
            setImportant(false);
          }}
        >
          <label className="tournament-field">
            <span>{t("tournaments.news.compose")}</span>
            <textarea
              value={body}
              onChange={(changed) => setBody(changed.target.value)}
              rows={3}
              maxLength={1000}
              placeholder={t("tournaments.news.placeholder")}
            />
          </label>
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
        <p className="muted">{t("tournaments.news.none")}</p>
      ) : (
        <ol className="tournament-news-list">
          {event.news.map((post) => (
            <li
              className={
                post.important
                  ? "surface tournament-news-post is-important"
                  : "surface tournament-news-post"
              }
              key={post.id}
            >
              <div className="tournament-news-head">
                <span className="tournament-news-by">{post.by}</span>
                {post.at !== null && (
                  <time className="muted" dateTime={new Date(post.at * 1000).toISOString()}>
                    {formatMoment(post.at, "")}
                  </time>
                )}
                {post.important && (
                  <span className="tournament-badge is-running">
                    {t("tournaments.news.importantBadge")}
                  </span>
                )}
                {organiser && (
                  <Button disabled={busy} onClick={() => onDelete(post.id)}>
                    {t("tournaments.news.remove")}
                  </Button>
                )}
              </div>
              <p className="tournament-description">{post.body}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
