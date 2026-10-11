// A private comment and tags on one replay (#324), in an overlay opened from
// the "Notes and tags" button under the replay's map preview.
//
// Kept on this machine with the player notes: a personal index to find games
// by ("Lots finals"), not a review, and nothing another player sees. Keyed by
// the game id, so the note written from the Online tab is on the downloaded
// file in the Local tab too. A file whose header names no game (a skirmish,
// an old recording) is keyed by its path instead, however that path is
// spelt; only a replay with neither has nothing to keep a note on.
//
// Drawn over the replay panel, as `ReplayInsights` is, and one layer of the
// overlay stack while open: one press of Escape closes the notes and leaves
// the replay open.

import { useId, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { useOverlayLayer } from "../../design-system/useOverlayLayer";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import {
  noteForReplay,
  parseTagInput,
  REPLAY_NOTE_CHARACTER_LIMIT,
} from "../../shared/rules/replayNotes";
import { useAppStore } from "../../store/store";
import "./replays.css";

/** Whether this replay carries a note, for the button's "on" state. */
export function useHasReplayNote(replayId: number, localPath?: string | null): boolean {
  return useAppStore(
    (state) => noteForReplay(state.state.settings.social.replayNotes, replayId, localPath) !== null,
  );
}

export function ReplayNotesDialog({
  replayId,
  localPath,
  title,
  onClose,
}: {
  replayId: number;
  /**
   * The file the panel is open on. What the note is kept on when the replay
   * has no game id; a game's note is the game's whichever file is open.
   */
  localPath?: string | null;
  /** The replay's own title, so the overlay says which game it annotates. */
  title: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const note = useAppStore((state) => noteForReplay(state.state.settings.social.replayNotes, replayId, localPath));
  const [comment, setComment] = useState(note?.comment ?? "");
  const [tags, setTags] = useState((note?.tags ?? []).join(", "));

  useOverlayLayer(true, onClose);

  const save = (nextComment: string, nextTags: string[]) => {
    ipc.send({
      kind: "Settings",
      command: {
        type: "setReplayNote",
        payload: { replayId, localPath: localPath ?? null, comment: nextComment, tags: nextTags },
      },
    });
    onClose();
  };
  const previewTags = parseTagInput(tags);

  return (
    <div className="replay-preview-scrim" role="presentation" onClick={onClose}>
      <div
        className="replay-notes surface-panel"
        role="dialog"
        aria-labelledby={headingId}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="replay-notes-head">
          <div>
            <h3 id={headingId}>{t("replays.notes.title")}</h3>
            <span className="muted" title={title}>{title}</span>
          </div>
          <button
            type="button"
            className="replay-card-icon-btn"
            aria-label={t("replays.notes.close")}
            title={t("replays.notes.close")}
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </header>
        <label className="replay-notes-field">
          <span>{t("replays.notes.comment")}</span>
          <textarea
            className="vault-input replay-notes-comment"
            value={comment}
            maxLength={REPLAY_NOTE_CHARACTER_LIMIT}
            rows={4}
            autoFocus
            placeholder={t("replays.notes.commentPlaceholder")}
            onChange={(event) => setComment(event.target.value)}
          />
        </label>
        <label className="replay-notes-field">
          <span>{t("replays.notes.tags")}</span>
          <input
            className="vault-input"
            value={tags}
            placeholder={t("replays.notes.tagsPlaceholder")}
            onChange={(event) => setTags(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") save(comment, previewTags);
            }}
          />
        </label>
        {previewTags.length > 0 && (
          <ul className="replay-notes-tags" aria-label={t("replays.notes.tags")}>
            {previewTags.map((tag) => <li key={tag}>{tag}</li>)}
          </ul>
        )}
        <footer className="replay-notes-actions">
          <span className="muted">{t("replays.notes.private")}</span>
          {note && <Button onClick={() => save("", [])}>{t("replays.notes.clear")}</Button>}
          <Button variant="primary" onClick={() => save(comment, previewTags)}>
            {t("replays.notes.save")}
          </Button>
        </footer>
      </div>
    </div>
  );
}
