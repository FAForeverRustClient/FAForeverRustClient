// The Java client's main menu: the button at the far left of its header bar,
// which holds what is not a place to play: the folders to reveal, the links
// out, and the settings.
//
// Rendered in every theme and drawn only by the one whose navigation is a bar
// across the top (themes/java-client.css). A sidebar has the same three as
// its bottom group, where they have room.

import { useState } from "react";
import type { Tab } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { FOLDER_GROUPS, openFolderEntry } from "../../shared/gameFolders";
import { useNavMenu } from "./NavOverflowMenu";

interface NavMainMenuProps {
  /** The tabs it offers, in order: those of the bottom group open to this session. */
  tabs: Tab[];
  onSelect: (tab: Tab) => void;
}

export function NavMainMenu({ tabs, onSelect }: NavMainMenuProps) {
  const { t } = useTranslation();
  const { open, setOpen, root, toggle } = useNavMenu();
  const [error, setError] = useState("");

  return (
    <div className="nav-main-menu" ref={root}>
      <button
        ref={toggle}
        type="button"
        className={`tab nav-main-menu-toggle${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("nav.menu")}
        title={t("nav.menu")}
        onClick={() => {
          setError("");
          setOpen((value) => !value);
        }}
      >
        <span className="nav-main-menu-bars" aria-hidden="true" />
      </button>
      {open && (
        <div className="nav-overflow-menu nav-main-menu-list" role="menu" aria-label={t("nav.menu")}>
          {FOLDER_GROUPS.map((group) => (
            <div key={group.id} role="group" aria-label={t(group.title)}>
              <p className="nav-menu-heading" aria-hidden="true">{t(group.title)}</p>
              {group.entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="menuitem"
                  className="nav-overflow-item"
                  onClick={() => {
                    openFolderEntry(entry).then(
                      () => setOpen(false),
                      (reason: unknown) => setError(String(reason)),
                    );
                  }}
                >
                  {t(entry.label)}
                </button>
              ))}
              <hr className="nav-menu-separator" />
            </div>
          ))}
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="menuitem"
              className="nav-overflow-item"
              onClick={() => {
                setOpen(false);
                onSelect(tab);
              }}
            >
              {t(`nav.tab.${tab}.label`)}
            </button>
          ))}
          {error && <p className="nav-menu-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
