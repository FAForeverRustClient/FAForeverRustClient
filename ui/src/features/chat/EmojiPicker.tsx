// The emoji picker attached to the composer.
//
// A popover rather than a dialog: picking an emoji is a step inside writing a
// message, and a modal would take the caret out of the input for something
// that takes half a second. It closes on Escape, on a click outside, and after
// a pick unless the pick was made with a modifier held, which is how people
// build a row of several.
//
// Keyboard use is the point, not an afterthought: the search box takes focus
// on open, typing narrows, and the arrow keys walk the grid. The Java client's
// emoticons popup is mouse-only and is worse for it.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import {
  EMOJI_GROUPS,
  groupOffsets,
  searchEmoji,
  stepSelection,
  type EmojiEntry,
} from "./emoji";

interface Props {
  disabled: boolean;
  /** Insert the character; the composer decides where. */
  onPick: (char: string) => void;
}

export function EmojiPicker({ disabled, onPick }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const container = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchEmoji(query), [query]);
  // Where each group starts in the flat list the arrow keys walk, so the
  // grouped view and the keyboard agree on one index space.
  const offsets = useMemo(() => groupOffsets(), []);
  // A narrowed list can be shorter than the current selection.
  const selected = Math.min(active, Math.max(results.length - 1, 0));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useLayoutEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setActive(0);
  };

  const pick = (entry: EmojiEntry, keepOpen: boolean) => {
    onPick(entry.char);
    if (!keepOpen) close();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (results.length === 0) return;

    if (event.key.startsWith("Arrow")) {
      event.preventDefault();
      setActive(stepSelection(selected, event.key, results.length));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      pick(results[selected], event.shiftKey || event.ctrlKey);
    }
  };

  // Grouped headings are only meaningful for the unfiltered list; a search
  // result is ranked across groups, so splitting it by group would reorder it.
  const searching = query.trim() !== "";

  return (
    <div className="emoji-picker" ref={container}>
      <button
        type="button"
        className="emoji-trigger"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={t("chat.emoji.open")}
        title={t("chat.emoji.open")}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon name="smile" />
      </button>

      {open ? (
        <div
          className="emoji-popover"
          role="dialog"
          aria-label={t("chat.emoji.title")}
          onKeyDown={onKeyDown}
        >
          <input
            ref={searchRef}
            className="chat-input emoji-search"
            type="text"
            value={query}
            placeholder={t("chat.emoji.search")}
            aria-label={t("chat.emoji.search")}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />

          <div className="emoji-scroll">
            {results.length === 0 ? (
              <p className="emoji-empty">{t("chat.emoji.noResults")}</p>
            ) : searching ? (
              <Grid entries={results} selected={selected} onPick={pick} />
            ) : (
              EMOJI_GROUPS.map((group, index) => (
                <section className="emoji-group" key={group.id}>
                  <h3 className="emoji-group-title">{t(group.label)}</h3>
                  <Grid
                    entries={group.emoji}
                    selected={selected}
                    offset={offsets[index]}
                    onPick={pick}
                  />
                </section>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Grid({
  entries,
  selected,
  offset = 0,
  onPick,
}: {
  entries: readonly EmojiEntry[];
  selected: number;
  /** Where this block starts in the flat result list the arrow keys walk. */
  offset?: number;
  onPick: (entry: EmojiEntry, keepOpen: boolean) => void;
}) {
  return (
    <div className="emoji-grid">
      {entries.map((entry, index) => {
        const flat = offset + index;
        return (
          <button
            type="button"
            key={entry.char}
            className={`emoji-tile${flat === selected ? " is-active" : ""}`}
            title={entry.name}
            aria-label={entry.name}
            onClick={(event) => onPick(entry, event.shiftKey || event.ctrlKey)}
          >
            {entry.char}
          </button>
        );
      })}
    </div>
  );
}
