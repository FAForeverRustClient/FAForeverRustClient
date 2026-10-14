// The sidebar's Game folders menu button.
//
// Opening the maps folder used to mean: Settings, the Paths section, scroll
// past nine rows of path configuration, then the row of buttons. That is the
// "doom scrolling" the issue describes, and it is the wrong shape for something
// people do while a game is loading.
//
// It opens a floating flyout menu to the right of the sidebar rather than an
// in-flow disclosure. An in-flow disclosure pushed adjacent navigation items
// ("External links") upward into the primary navigation space and caused jarring
// layout shifts; a floating popover anchored to the right of the sidebar keeps
// all sidebar tabs stationary while working seamlessly in both standard and
// collapsed rail navigation modes.

import { useOverlayLayer } from "../../design-system/useOverlayLayer";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import { FOLDER_GROUPS, openFolderEntry, type FolderEntry } from "../../shared/gameFolders";
import { plainError } from "../../shared/plainError";
import "./game-folders.css";

// The menu's size in English before it has been measured, for its first
// frame: close to the real one, so it does not visibly jump into place.
const ESTIMATED_WIDTH = 212;
const ESTIMATED_HEIGHT = 340;

export function GameFoldersMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The shell's own message, kept as it came and shown under the list through
  // `plainError` rather than swallowed: a folder that is not there yet (no
  // replays played, no vault) is the common case and the reason has to be
  // readable.
  const [error, setError] = useState("");

  const place = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const menu = menuRef.current?.getBoundingClientRect();
    const menuHeight = menu?.height ?? ESTIMATED_HEIGHT;
    const menuWidth = menu?.width ?? ESTIMATED_WIDTH;

    // Position to the right of the trigger / sidebar
    let left = trigger.right + 8;
    if (left + menuWidth > viewportWidth - 8) {
      left = Math.max(8, trigger.left - menuWidth - 8);
    }

    // Align bottom of popover with bottom of trigger
    let top = trigger.bottom - menuHeight;
    if (top < 8) {
      top = 8;
    }
    if (top + menuHeight > viewportHeight - 8) {
      top = Math.max(8, viewportHeight - menuHeight - 8);
    }

    setPosition({ top: Math.round(top), left: Math.round(left) });
  }, []);

  useEffect(() => {
    if (open) {
      place();
    }
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const handlePointerDown = (event: PointerEvent) => {
      const node = event.target as Node;
      if (menuRef.current?.contains(node) || triggerRef.current?.contains(node)) return;
      close();
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", close);
    };
  }, [open, place]);

  useOverlayLayer(open, () => { setOpen(false); triggerRef.current?.focus(); });

  const handleToggle = () => {
    if (!open) {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (trigger) {
        const left = Math.round(trigger.right + 8);
        const top = Math.round(Math.max(8, trigger.bottom - ESTIMATED_HEIGHT));
        setPosition({ top, left });
      }
    }
    setOpen((value) => !value);
  };

  const openEntry = async (entry: FolderEntry) => {
    setError("");
    try {
      await openFolderEntry(entry);
      setOpen(false);
    } catch (reason) {
      setError(String(reason));
    }
  };

  return (
    <div className="game-folders">
      <button
        ref={triggerRef}
        type="button"
        className={open ? "tab game-folders-toggle is-open" : "tab game-folders-toggle"}
        aria-expanded={open}
        aria-haspopup="menu"
        title={t("gameFolders.title")}
        onClick={handleToggle}
      >
        <Icon name="folder" size={17} />
        <span>{t("gameFolders.title")}</span>
        <Icon className="game-folders-caret" name="chevronRight" size={14} />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="game-folders-popover"
            role="menu"
            aria-label={t("gameFolders.title")}
            style={{ top: position.top, left: position.left }}
          >
            {FOLDER_GROUPS.map((group) => (
              <div className="game-folders-group" key={group.id} role="none">
                <p className="game-folders-group-title">{t(group.title)}</p>
                {group.entries.map((entry) => (
                  <button
                    type="button"
                    role="menuitem"
                    className="game-folders-entry"
                    key={entry.id}
                    onClick={() => void openEntry(entry)}
                  >
                    <Icon className="game-folders-entry-icon" name={entry.icon} size={16} />
                    <span className="game-folders-entry-label">{t(entry.label)}</span>
                    {/* It opens outside the client, in the file manager: said
                        on the row being pointed at, not on all eight. */}
                    <Icon className="game-folders-entry-opens" name="external" size={13} />
                  </button>
                ))}
              </div>
            ))}
            {/* Plainly, with the shell's own words ("could not open
                C:\...\maps: ...") on hover. No Retry of its own: the entry
                that failed is one click away in this same menu. */}
            {error && (
              <p className="game-folders-error" role="alert" title={error}>
                {plainError(error)}
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
