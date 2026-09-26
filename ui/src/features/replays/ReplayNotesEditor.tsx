// A private comment and tags on one replay (#324), in the replay's own panel.
//
// Kept on this machine with the player notes: a personal index to find games
// by ("Lots finals"), not a review, and nothing another player sees. Keyed by
// the game id, so the note written from the Online tab is on the downloaded
// file in the Local tab too. A file with no game id has nothing to key it by,
// so it gets no editor rather than a note that could never be found again.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import {
  noteForReplay,
  parseTagInput,
  REPLAY_NOTE_CHARACTER_LIMIT,
} from "../../shared/rules/replayNotes";
import { useAppStore } from "../../store/store";
import "./replays.css";

export function ReplayNotesEditor({ replayId }: { replayId: number }) {
  const { t } = useTranslation();
  const note = useAppStore((state) => noteForReplay(state.state.settings.social.replayNotes, replayId));
  const savedComment = note?.comment ?? "";
  const savedTags = (note?.tags ?? []).join(", ");
  const [comment, setComment] = useState(savedComment);
  const [tags, setTags] = useState(savedTags);

  // Follows the saved note when another panel, or a save here, changes it.
  useEffect(() => setComment(savedComment), [savedComment]);
  useEffect(() => setTags(savedTags), [savedTags]);

  if (replayId <= 0) return null;

  const dirty = comment.trim() !== savedComment || parseTagInput(tags).join(", ") !== savedTags;
  const save = (nextComment: string, nextTags: string[]) =>
    ipc.send({
      kind: "Settings",
      command: { type: "setReplayNote", payload: { replayId, comment: nextComment, tags: nextTags } },
    });

  return (
    <section className="replay-notes" aria-labelledby={`replay-notes-${replayId}`}>
      <div className="replay-notes-head">
        <h3 id={`replay-notes-${replayId}`}>{t("replays.notes.title")}</h3>
        <span className="muted">{t("replays.notes.private")}</span>
      </div>
      {(note?.tags.length ?? 0) > 0 && (
        <ul className="replay-notes-tags" aria-label={t("replays.notes.tags")}>
          {note?.tags.map((tag) => <li key={tag}>{tag}</li>)}
        </ul>
      )}
      <textarea
        className="vault-input replay-notes-comment"
        value={comment}
        maxLength={REPLAY_NOTE_CHARACTER_LIMIT}
        rows={2}
        placeholder={t("replays.notes.commentPlaceholder")}
        aria-label={t("replays.notes.comment")}
        onChange={(event) => setComment(event.target.value)}
      />
      <div className="replay-notes-row">
        <input
          className="vault-input replay-notes-tag-input"
          value={tags}
          placeholder={t("replays.notes.tagsPlaceholder")}
          aria-label={t("replays.notes.tags")}
          onChange={(event) => setTags(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && dirty) save(comment, parseTagInput(tags));
          }}
        />
        <Button variant="primary" disabled={!dirty} onClick={() => save(comment, parseTagInput(tags))}>
          {t("replays.notes.save")}
        </Button>
        {note && (
          <Button onClick={() => save("", [])}>{t("replays.notes.clear")}</Button>
        )}
      </div>
    </section>
  );
}
