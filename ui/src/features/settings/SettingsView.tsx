// Settings: a sidebar of sections, one section on the page.
//
// The shape every desktop client uses for this, because a settings tab is a
// place people come to do one thing and leave: find the row, change it, go
// back to the game. So the sidebar lists plain names with an icon, the tab
// opens on the first section rather than on a table of contents, and the page
// is a heading and its panels, nothing above the heading.
//
// Every section stays mounted and all but one are hidden, which is not a
// detail: it is what lets the search read the rows that rendered rather than
// a list maintained beside them (see `settingsSearch`), and it costs no more
// than a single long page, which rendered every section at all times anyway.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import { FIRST_SECTION, SECTIONS, SECTION_ORDER, type SectionKey } from "./sections";
import { SettingsSectionScope, useSettingsIndexEntry } from "./SettingControls";
import {
  clearSettingsRequest,
  pendingSettingsRequest,
  subscribeToSettingsRequest,
} from "./settingsNavigation";
import {
  sectionMatches,
  settingsIndexRevision,
  subscribeToSettingsIndex,
} from "./settingsSearch";
import "./settings.css";

/**
 * A section's search words, which are indexed and never drawn.
 *
 * These carry the terms people type that no label on the page uses: "fps",
 * "nickname", "vault". Drawing them would be a paragraph of keyword soup under
 * every heading, so they are contributed to the index and nothing else.
 */
function SectionKeywords({ text }: { text: string }) {
  useSettingsIndexEntry(text);
  return null;
}

export function SettingsView() {
  const { t } = useTranslation();
  const [active, setActive] = useState<SectionKey>(FIRST_SECTION);
  const [search, setSearch] = useState("");
  const query = search.trim();
  const pageRef = useRef<HTMLDivElement>(null);

  // The index fills in as rows mount, so the match set has to be recomputed
  // when it changes and not only when the query does.
  const revision = useSyncExternalStore(subscribeToSettingsIndex, settingsIndexRevision);
  const matches = useMemo(
    () => new Set(SECTION_ORDER.filter((key) => sectionMatches(key, query))),
    // `revision` is the dependency that matters; it is not read in the body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [query, revision],
  );

  // A search that excludes the section you are looking at would leave you
  // reading a page the sidebar says has no matches, so move to the first one
  // that does.
  useEffect(() => {
    if (!query || matches.has(active)) return;
    const first = SECTION_ORDER.find((key) => matches.has(key));
    if (first) setActive(first);
  }, [query, matches, active]);

  // Each section is its own page, so it starts at the top like one.
  useEffect(() => {
    pageRef.current?.scrollTo({ top: 0 });
  }, [active]);

  // A notification that sends you into Settings names the section it meant.
  // Consumed here rather than acted on by the sender, because the sender has
  // navigated to the tab and this component may not have existed yet.
  const requested = useSyncExternalStore(subscribeToSettingsRequest, pendingSettingsRequest);
  useEffect(() => {
    if (!requested) return;
    setActive(requested);
    setSearch("");
    clearSettingsRequest();
  }, [requested]);

  return (
    <div className="settings-view">
      <nav className="settings-sidebar" aria-label={t("settings.sections.aria")}>
        <div className="settings-sidebar-head">
          <h2 className="view-title">{t("settings.title")}</h2>
          <label className="settings-search-field">
            <Icon name="search" size={15} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("settings.search.placeholder")}
              aria-label={t("settings.search.placeholder")}
            />
            {search && (
              <button
                type="button"
                aria-label={t("settings.search.clearAria")}
                title={t("settings.search.clearTitle")}
                onClick={() => setSearch("")}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </label>
          {/* Only while searching: the count is the answer to "did that
              find anything", and it has no answer to give otherwise. */}
          {query && (
            <p className="settings-search-count muted" aria-live="polite">
              {t("settings.search.sectionMatches", { count: matches.size })}
            </p>
          )}
        </div>

        <ul className="settings-sidebar-list">
          {SECTION_ORDER.map((key) => {
            const section = SECTIONS[key];
            // Dimmed rather than removed: a list that reorders itself while
            // somebody types loses the shape they were navigating by.
            const dimmed = query !== "" && !matches.has(key);
            return (
              <li key={key}>
                <button
                  type="button"
                  className={`settings-sidebar-item${active === key ? " is-active" : ""}${dimmed ? " is-dimmed" : ""}`}
                  aria-current={active === key ? "page" : undefined}
                  onClick={() => setActive(key)}
                >
                  <Icon name={section.icon} size={16} />
                  <span className="settings-sidebar-name">{t(section.title)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="settings-page-scroll" ref={pageRef}>
        {SECTION_ORDER.map((key) => {
          const section = SECTIONS[key];
          return (
            <div className="settings-page" key={key} hidden={active !== key}>
              <header className="settings-page-head">
                <h3 className="settings-page-title">{t(section.title)}</h3>
                <p className="muted">{t(section.description)}</p>
              </header>
              <SettingsSectionScope section={key}>
                <SectionKeywords text={t(section.keywords)} />
                {section.panels.map((Panel, index) => (
                  <Panel key={index} />
                ))}
              </SettingsSectionScope>
            </div>
          );
        })}
      </div>
    </div>
  );
}
