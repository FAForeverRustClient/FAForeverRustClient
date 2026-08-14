import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import { PLAYER_NOTE_CHARACTER_LIMIT } from "../../shared/playerNotes";

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
      <label htmlFor={`player-note-${playerId}`}>Private note about {login}</label>
      <textarea
        id={`player-note-${playerId}`}
        value={note}
        rows={4}
        placeholder="Add a reminder visible only in this client…"
        onChange={(event) => setNote(clampNote(event.target.value))}
      />
      <div className="player-note-editor-footer">
        <span className={characterCount === PLAYER_NOTE_CHARACTER_LIMIT ? "is-limit" : "muted"}>
          {characterCount} / {PLAYER_NOTE_CHARACTER_LIMIT}
        </span>
        <div className="player-note-editor-actions">
          {initialNote && <Button disabled={saving} onClick={() => setNote("")}>Clear</Button>}
          <Button disabled={saving} onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Saving…" : note.trim() ? "Save note" : "Remove note"}
          </Button>
        </div>
      </div>
      {error && <p className="player-note-error" role="alert">Could not save note: {error}</p>}
    </form>
  );
}

export function PlayerNoteModal(props: {
  playerId: number;
  login: string;
  initialNote: string;
  onClose: () => void;
}) {
  return (
    <Modal className="player-note-modal" ariaLabel={`Private note about ${props.login}`} onClose={props.onClose}>
      <div className="player-note-modal-head">
        <span className="player-card-eyebrow">Private player note</span>
        <h2>{props.login}</h2>
        <p className="muted">Stored locally by player ID. Other players cannot see it.</p>
      </div>
      <PlayerNoteEditor {...props} />
    </Modal>
  );
}

export function PlayerNoteCard({ note, onEdit }: { note: string; onEdit: () => void }) {
  return (
    <section className="player-note-card surface">
      <div>
        <span className="player-card-eyebrow">Private note</span>
        <p className={note ? undefined : "muted"}>{note || "No note saved for this player."}</p>
      </div>
      <Button onClick={onEdit}>{note ? "Edit note" : "Add note"}</Button>
    </section>
  );
}
