// Every replay tag in one place, to rename or delete (#324).
//
// Tags are written one replay at a time, and the mistakes are made the same
// way: a typo, or a tag that has outlived its use ("Lots finals" after Lots).
// Fixing that one replay at a time was the complaint, so here each tag is one
// row with the number of games that carry it, and a rename or a delete applies
// to all of them at once.

import { useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { MultiSelect } from "../../design-system/MultiSelect";
import { ipc } from "../../ipc/client";
import { useTranslation } from "../../i18n/useTranslation";
import { allReplayTags, REPLAY_TAG_CHARACTER_LIMIT } from "../../shared/rules/replayNotes";
import { useAppStore } from "../../store/store";
import "./replays.css";

function renameTag(from: string, to: string) {
  ipc.send({ kind: "Settings", command: { type: "renameReplayTag", payload: { from, to } } });
}

export function ReplayTagsDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const notes = useAppStore((state) => state.state.settings.social.replayNotes);
  const tags = useMemo(() => allReplayTags(notes), [notes]);
  const counts = useMemo(() => {
    const byTag = new Map<string, number>();
    for (const note of notes) {
      for (const tag of note.tags) {
        const key = tag.toLocaleLowerCase();
        byTag.set(key, (byTag.get(key) ?? 0) + 1);
      }
    }
    return byTag;
  }, [notes]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const startEditing = (tag: string) => {
    setEditing(tag);
    setDraft(tag);
  };
  const commit = () => {
    if (editing && draft.trim() && draft.trim() !== editing) renameTag(editing, draft.trim());
    setEditing(null);
  };

  return (
    <Modal className="replay-tags-modal" ariaLabel={t("replays.tags.title")} onClose={onClose}>
      <div className="replay-tags">
        <h2>{t("replays.tags.title")}</h2>
        <p className="muted">{t("replays.tags.hint")}</p>
        {tags.length === 0 ? (
          <p className="muted replay-tags-empty">{t("replays.tags.empty")}</p>
        ) : (
          <ul className="replay-tags-list">
            {tags.map((tag) => (
              <li key={tag} className="replay-tags-row">
                {editing === tag ? (
                  <input
                    className="vault-input replay-tags-input"
                    value={draft}
                    maxLength={REPLAY_TAG_CHARACTER_LIMIT}
                    autoFocus
                    aria-label={t("replays.tags.renameAria", { tag })}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commit();
                      if (event.key === "Escape") {
                        // Leave the dialog open: Escape here only abandons the rename.
                        event.stopPropagation();
                        setEditing(null);
                      }
                    }}
                  />
                ) : (
                  <span className="replay-tags-name">{tag}</span>
                )}
                <span className="muted replay-tags-count">
                  {t("replays.tags.games", { count: counts.get(tag.toLocaleLowerCase()) ?? 0 })}
                </span>
                {editing === tag ? (
                  <Button variant="primary" onClick={commit}>{t("replays.tags.save")}</Button>
                ) : (
                  <Button onClick={() => startEditing(tag)}>{t("replays.tags.rename")}</Button>
                )}
                <Button onClick={() => renameTag(tag, "")} aria-label={t("replays.tags.deleteAria", { tag })}>
                  {t("replays.tags.delete")}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="replay-tags-actions">
          <Button onClick={onClose}>{t("replays.tags.close")}</Button>
        </div>
      </div>
    </Modal>
  );
}

/** The "Manage tags" link under a tag picker, with its dialog. */
/**
 * The "Your tags" filter both replay tabs show. "Manage tags" is the first
 * entry of its dropdown: it acts on the very list the dropdown holds, and a
 * link underneath the field was easy to miss and looked like a stray note.
 */
export function ReplayTagFilter({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: string[];
  onChange: (tags: string[]) => void;
}) {
  const { t } = useTranslation();
  const [managing, setManaging] = useState(false);
  return (
    <>
      <MultiSelect
        label={t("replays.filters.yourTags")}
        anyLabel={t("replays.filters.anyTag")}
        options={options.map((tag) => ({ value: tag, label: tag }))}
        selected={selected}
        onChange={onChange}
        action={{ label: t("replays.tags.manage"), onSelect: () => setManaging(true) }}
      />
      {managing && <ReplayTagsDialog onClose={() => setManaging(false)} />}
    </>
  );
}
