import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { useOverlayLayer } from "../../design-system/useOverlayLayer";
import { useTranslation } from "../../i18n/useTranslation";
import { ipc } from "../../ipc/client";
import {
  MAX_SEARCH_PRESET_NAME_CHARS,
  MAX_SEARCH_PRESETS_PER_LIST,
} from "../../shared/browsingPreferences";
import "../../design-system/multi-select.css";

export interface SavedSearchEntry<T> {
  name: string;
  /** The stored query as saved, so a delete can be undone exactly. */
  saved: string;
  summary: string;
  signature: string;
  value: T;
}

interface Props<T> {
  list: string;
  entries: SavedSearchEntry<T>[];
  currentSignature: string;
  encodeCurrent: () => string;
  onApply: (value: T) => void;
}

export function ReplaySavedSearches<T>({
  list,
  entries,
  currentSignature,
  encodeCurrent,
  onApply,
}: Props<T>) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [filter, setFilter] = useState("");
  // The search the last delete removed, until the popover closes: the trash
  // button sits beside the row's apply button, and one slip lost a search.
  const [deleted, setDeleted] = useState<{ name: string; saved: string } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) setDeleted(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  useOverlayLayer(open, () => {
    setOpen(false);
    rootRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  });

  const activeEntry = useMemo(
    () => entries.find((entry) => entry.signature === currentSignature) ?? null,
    [currentSignature, entries],
  );

  const trimmedDraft = [...draftName.trim()].slice(0, MAX_SEARCH_PRESET_NAME_CHARS).join("");
  const overwriteTarget = useMemo(() => {
    if (!trimmedDraft) return null;
    const wanted = trimmedDraft.toLowerCase();
    return entries.find((entry) => entry.name.trim().toLowerCase() === wanted) ?? null;
  }, [entries, trimmedDraft]);

  const canSave =
    trimmedDraft.length > 0
    && (overwriteTarget !== null || entries.length < MAX_SEARCH_PRESETS_PER_LIST);

  const shown = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    if (!needle) return entries;
    return entries.filter(
      (entry) =>
        entry.name.toLocaleLowerCase().includes(needle)
        || entry.summary.toLocaleLowerCase().includes(needle),
    );
  }, [entries, filter]);

  const send = (name: string, query: string) =>
    void ipc.send({
      kind: "Settings",
      command: { type: "saveSearchPreset", payload: { preset: { list, name, query } } },
    });

  const savePreset = () => {
    if (!canSave) return;
    send(trimmedDraft, encodeCurrent());
    setDraftName("");
    setDeleted(null);
  };

  const deletePreset = (entry: SavedSearchEntry<T>) => {
    void ipc.send({
      kind: "Settings",
      command: {
        type: "deleteSearchPreset",
        payload: { list, name: entry.name },
      },
    });
    setDeleted({ name: entry.name, saved: entry.saved });
  };

  const undoDelete = () => {
    if (!deleted) return;
    send(deleted.name, deleted.saved);
    setDeleted(null);
  };

  const applyEntry = (entry: SavedSearchEntry<T>) => {
    setOpen(false);
    setFilter("");
    onApply(entry.value);
  };

  const label = entries.length > 0
    ? t("replays.search.presetsCount", { count: entries.length })
    : t("replays.search.presets");

  return (
    <div className="multi-select replay-saved-searches" ref={rootRef}>
      <Button
        type="button"
        className={activeEntry ? "has-active-preset" : ""}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          activeEntry
            ? t("replays.search.presetsActiveHint", { name: activeEntry.name })
            : t("replays.search.presetsHint")
        }
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name="star" size={14} /> {label}
      </Button>
      {open && (
        <div
          className="multi-select-popover replay-saved-searches-popover"
          role="dialog"
          aria-label={t("replays.search.presets")}
        >
          <div className="replay-preset-save-section">
            <div className="replay-preset-save-row">
              <input
                className="vault-input replay-preset-name-input"
                type="text"
                autoFocus
                maxLength={MAX_SEARCH_PRESET_NAME_CHARS}
                value={draftName}
                aria-label={t("replays.search.presetsNameAria")}
                placeholder={t("replays.search.presetsNamePlaceholder")}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    savePreset();
                  }
                }}
              />
              <Button
                type="button"
                variant="primary"
                className="replay-preset-save-btn"
                disabled={!canSave}
                onClick={savePreset}
              >
                {overwriteTarget
                  ? t("replays.search.presetsOverwrite")
                  : t("replays.search.presetsSave")}
              </Button>
            </div>
            {overwriteTarget && (
              <p className="muted replay-preset-overwrite-note">
                {t("replays.search.presetsWillOverwrite", { name: overwriteTarget.name })}
              </p>
            )}
            {deleted && (
              <p className="muted replay-preset-deleted" role="status">
                {t("replays.search.presetsDeleted", { name: deleted.name })}{" "}
                <button type="button" className="replay-preset-undo" onClick={undoDelete}>
                  {t("replays.search.presetsUndo")}
                </button>
              </p>
            )}
          </div>

          {entries.length === 0 ? (
            <p className="muted multi-select-empty replay-preset-empty">
              {t("replays.search.presetsEmpty")}
            </p>
          ) : (
            <div className="replay-preset-list-section">
              {entries.length > 8 && (
                <input
                  className="friend-replay-filter replay-preset-filter"
                  type="search"
                  value={filter}
                  aria-label={t("replays.search.presetsFilter")}
                  placeholder={t("replays.search.presetsFilter")}
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      event.stopPropagation();
                    }
                  }}
                />
              )}
              <div className="replay-preset-list">
                {shown.length === 0 ? (
                  <p className="muted multi-select-empty">{t("replays.search.presetsNoMatch")}</p>
                ) : (
                  shown.map((entry) => {
                    const isActive = activeEntry?.name === entry.name;
                    return (
                      <div
                        key={entry.name}
                        className={`replay-preset-row${isActive ? " is-active" : ""}`}
                      >
                        <button
                          type="button"
                          className="replay-preset-apply"
                          aria-current={isActive ? "true" : undefined}
                          title={`${entry.name}: ${entry.summary}`}
                          onClick={() => applyEntry(entry)}
                        >
                          <span className="replay-preset-head">
                            <span className="replay-preset-name">{entry.name}</span>
                            {isActive && (
                              <Icon name="check" size={14} className="replay-preset-check" />
                            )}
                          </span>
                          <span className="replay-preset-summary">{entry.summary}</span>
                        </button>
                        <button
                          type="button"
                          className="replay-preset-delete"
                          aria-label={t("replays.search.presetsDeleteAria", { name: entry.name })}
                          title={t("replays.search.presetsDeleteAria", { name: entry.name })}
                          onClick={() => deletePreset(entry)}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
