import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import { PLAYER_NOTE_CHARACTER_LIMIT } from "../../shared/playerNotes";
import { useTranslation } from "../../i18n/useTranslation";

function clampNote(value: string): string {
  return Array.from(value).slice(0, PLAYER_NOTE_CHARACTER_LIMIT).join("");
}

export function PlayerNoteEditor({
  playerId,
  login,
  initialNote,
  onClose,
}: {
  playerId: number;
  login: string;
  initialNote: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState(initialNote);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const characterCount = Array.from(note).length;

  useEffect(() => {
    setNote(initialNote);
    setError("");
  }, [initialNote, playerId]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await ipc.dispatch({
        kind: "Settings",
        command: { type: "setPlayerNote", payload: { player_id: playerId, login, note } },
      });
      onClose();
    } catch (reason) {
      setError(String(reason));
      setSaving(false);
    }
  };

  return (
    <form className="player-note-editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label htmlFor={`player-note-${playerId}`}>{t("playerCard.note.label", { login })}</label>
      <textarea
        id={`player-note-${playerId}`}
        value={note}
        rows={4}
        placeholder={t("playerCard.note.placeholder")}
        onChange={(event) => setNote(clampNote(event.target.value))}
      />
      <div className="player-note-editor-footer">
        <span className={characterCount === PLAYER_NOTE_CHARACTER_LIMIT ? "is-limit" : "muted"}>
          {characterCount} / {PLAYER_NOTE_CHARACTER_LIMIT}
        </span>
        <div className="player-note-editor-actions">
          {initialNote && <Button disabled={saving} onClick={() => setNote("")}>{t("playerCard.note.clear")}</Button>}
          <Button disabled={saving} onClick={onClose}>{t("playerCard.note.cancel")}</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {t(saving ? "playerCard.note.saving" : note.trim() ? "playerCard.note.save" : "playerCard.note.remove")}
          </Button>
        </div>
      </div>
      {error && <p className="player-note-error" role="alert">{t("playerCard.note.saveFailed", { error })}</p>}
    </form>
  );
}

export function PlayerNoteModal(props: {
  playerId: number;
  login: string;
  initialNote: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal className="player-note-modal" ariaLabel={t("playerCard.note.label", { login: props.login })} onClose={props.onClose}>
      <div className="player-note-modal-head">
        <span className="player-card-eyebrow">{t("playerCard.note.modalEyebrow")}</span>
        <h2>{props.login}</h2>
        <p className="muted">{t("playerCard.note.modalHint")}</p>
      </div>
      <PlayerNoteEditor {...props} />
    </Modal>
  );
}

export function PlayerNoteCard({
  playerId,
  login,
  note,
}: {
  playerId: number;
  login: string;
  note: string;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <section className="player-note-card surface is-editing">
        <PlayerNoteEditor
          playerId={playerId}
          login={login}
          initialNote={note}
          onClose={() => setEditing(false)}
        />
      </section>
    );
  }

  return (
    <section className="player-note-card surface">
      <div>
        <span className="player-card-eyebrow">{t("playerCard.note.cardEyebrow")}</span>
        <p className={note ? undefined : "muted"}>{note || t("playerCard.note.cardEmpty")}</p>
      </div>
      <Button onClick={() => setEditing(true)}>{t(note ? "playerCard.note.edit" : "playerCard.note.add")}</Button>
    </section>
  );
}
