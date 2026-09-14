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

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import { FOLDER_GROUPS, openFolderEntry, type FolderEntry } from "./gameFolders";
import "./game-folders.css";

export function GameFoldersMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The shell's own message, shown under the list rather than swallowed: a
  // folder that is not there yet (no replays played, no vault) is the common
  // case and the reason has to be readable.
  const [error, setError] = useState("");

  const place = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const menu = menuRef.current?.getBoundingClientRect();
    const menuHeight = menu?.height ?? 270;
    const menuWidth = menu?.width ?? 200;

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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", close);
    };
  }, [open, place]);

  const handleToggle = () => {
    if (!open) {
      const trigger = triggerRef.current?.getBoundingClientRect();
      if (trigger) {
        const left = Math.round(trigger.right + 8);
        const top = Math.round(Math.max(8, trigger.bottom - 270));
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
                    {t(entry.label)}
                  </button>
                ))}
              </div>
            ))}
            {error && (
              <p className="game-folders-error" role="alert">
                {error}
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
