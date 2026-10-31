// Patch notes from FAForever/fa, rendered in the client's own chrome.
//
// The published site is a light-themed Jekyll page, so an iframe would drop a
// white document into a dark client. The backend parses the same source into
// blocks (see faf-domain's `protocol::changelog`) and this renders them, which
// also means the unit icons, balance diffs and issue links keep their meaning
// instead of arriving as a wall of text.
//
// Two surfaces: the release list, and one reading surface holding the note's
// header, the note itself at a reading measure, and its sections. The sections
// sit in a column beside the note when the surface is wide enough to have
// room for one, and as a row of jump links above it when it is not, so the
// note never shares its width with an empty margin or a third panel.
//
// The tab has three sections: the game's patches and this client's own
// releases, which share that layout (`noteReader`) so they read as one tab,
// and one unit's values across the game's patches (`UnitHistoryView`), which
// links back into the first.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { Icon } from "../../design-system/Icon";
import { SectionTabs, sectionPanelProps } from "../../design-system/SectionTabs";
import { StatusNotice } from "../../design-system/StatusNotice";
import { ipc } from "../../ipc/client";
import { openChangelogLink } from "../../shared/changelogLinks";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n";
import { useRememberedFilter } from "../../shared/filterMemory";
import { plainError } from "../../shared/plainError";
import { formatDate } from "../../shared/format/dates";
import { FeaturedModIcon } from "../../shared/components/FeaturedModIcon";
import type { ChangelogBlock, ChangelogRelease, ChangelogSearchMatch, ChangelogSection } from "../../ipc/bindings";
import { ClientReleasesView } from "./ClientReleasesView";
import { PatchSearch } from "./PatchSearch";
import { historicalKindKey, isRollingRelease, LEGACY_GROUP, releaseGroup, releaseLabel, UNDATED_GROUP } from "./releasePresentation";
import { UnitHistoryView } from "./UnitHistoryView";
import { changelogViewMemory } from "./viewMemory";
import {
  anchorFor,
  keepCurrentRowInView,
  NoteBlocks,
  NoteContentsColumn,
  NoteJumpRow,
  showsContents,
  noteSections,
  useNoteContents,
  useNoteListPosition,
  type Section,
} from "./noteReader";
import { bundledNoteIllustrations } from "../../shared/historicalChangelogIcons";
import "./changelog.css";

/** Rolling branches have no date and belong above the dated years. */
const BRANCH_GROUP = "";

type Translate = ReturnType<typeof useTranslation>["t"];

const SECTIONS: Record<ChangelogSection, MessageKey> = {
  game: "changelog.section.game",
  client: "changelog.section.client",
  units: "changelog.section.units",
};

/**
 * The section is the backend's, like the vaults' sources, so it survives the
 * tab unmounting when another one is chosen, and so the update banner and the
 * What's new popup can open the tab on a client release.
 */
const selectSection = (section: ChangelogSection) =>
  ipc.send({ kind: "Nav", command: { type: "selectChangelogSection", payload: { section } } });

export function ChangelogView() {
  const { t } = useTranslation();
  const section = useAppStore((state) => state.state.nav.changelogSection);
  const [jumpTarget, setJumpTarget] = useState<ChangelogSearchMatch | null>(null);

  return (
    <div className="changelog-workspace">
      <div className="vault-subnav changelog-subnav">
        <SectionTabs
          active={section}
          ariaLabel={t("changelog.section.aria")}
          items={(Object.keys(SECTIONS) as ChangelogSection[]).map((key) => ({ id: key, label: t(SECTIONS[key]) }))}
          onChange={selectSection}
          idPrefix="changelog-section"
        />
        <PatchSearch onChoose={match => {
          setJumpTarget(match);
          selectSection("game");
          ipc.send({ kind: "Changelog", command: { type: "select", payload: { id: match.releaseId } } });
        }} />
      </div>
      <div className="changelog-panel" {...sectionPanelProps("changelog-section", section)}>
        {section === "client" ? (
          <ClientReleasesView />
        ) : section === "units" ? (
          <UnitHistoryView
            onOpenRelease={(id) => {
              selectSection("game");
              ipc.send({ kind: "Changelog", command: { type: "select", payload: { id } } });
            }}
          />
        ) : (
          <GameChangelogView jumpTarget={jumpTarget} onJumped={() => setJumpTarget(null)} />
        )}
      </div>
    </div>
  );
}

/** The upstream kind, in the reader's language where the client knows it. */
// The upstream kinds, compared without regard to case: they come from the
// site's post titles ("3837 - Game Patch").
const isPatch = (kind: string) => kind.toLowerCase() === "game patch";
const isHotfix = (kind: string) => kind.toLowerCase() === "hotfix";

function kindLabel(kind: string, t: Translate): string {
  const historical = historicalKindKey(kind);
  if (historical) return t(historical);
  if (isPatch(kind)) return t("changelog.kind.patch");
  if (isHotfix(kind)) return t("changelog.kind.hotfix");
  return kind;
}

/** Day and month only: the list already groups by year. */
function listDate(date: string): string {
  return formatDate(date, "", { day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * The note's own first heading, which names the release ("Game version 3836
 * (May 15, 2026)"), becomes the page title rather than repeating under it.
 * Its trailing date is dropped when the release carries one, because the line
 * under the title prints that date already.
 */
function noteTitle(blocks: ChangelogBlock[], fallback: string, hasDate: boolean): { title: string; skipFirst: boolean } {
  const first = blocks[0];
  if (first?.type !== "heading" || first.payload.level !== 1) return { title: fallback, skipFirst: false };
  const text = hasDate ? first.payload.text.replace(/\s*\([^()]*\)\s*$/, "") : first.payload.text;
  return { title: text || fallback, skipFirst: true };
}

function GameChangelogView({ jumpTarget, onJumped }: { jumpTarget: ChangelogSearchMatch | null; onJumped: () => void }) {
  const { t } = useTranslation();
  // Search progress changes independently of the note and its release list.
  const releases = useAppStore((state) => state.state.changelog.releases);
  const status = useAppStore((state) => state.state.changelog.status);
  const entryStatus = useAppStore((state) => state.state.changelog.entryStatus);
  const selectedId = useAppStore((state) => state.state.changelog.selected);
  const entries = useAppStore((state) => state.state.changelog.entries);
  const indexUnavailable = useAppStore((state) => state.state.changelog.indexUnavailable ?? null);
  const changelog = { releases, status, entryStatus, selected: selectedId, entries, indexUnavailable };
  // Remembered as the filter setting says (#447).
  const [search, setSearch] = useRememberedFilter("changelog.search", "", (value) => typeof value === "string");
  /// The years the reader has flipped from their default, folded or open.
  const [toggledGroups, setToggledGroups] = useState<Set<string>>(() => new Set(changelogViewMemory.game.years));
  const listRef = useRef<HTMLElement>(null);
  const listedSelection = useRef(changelogViewMemory.game.position?.selection);
  const onListScroll = useNoteListPosition(listRef, "game", status.type === "ready");
  const initialJump = useRef(jumpTarget);

  useEffect(() => {
    if (!initialJump.current) ipc.send({ kind: "Changelog", command: { type: "load" } });
  }, []);

  const query = search.trim().toLocaleLowerCase();
  const filtered = useMemo(() => {
    if (!query) return changelog.releases;
    return changelog.releases.filter(
      (release) =>
        release.id.toLocaleLowerCase().includes(query) ||
        release.kind.toLocaleLowerCase().includes(query) ||
        kindLabel(release.kind, t).toLocaleLowerCase().includes(query) ||
        release.date.includes(query),
    );
  }, [changelog.releases, query, t]);

  // Grouped the way the site groups them, so a release is where a reader who
  // knows the site expects it.
  const groups = useMemo(() => {
    const byYear = new Map<string, ChangelogRelease[]>();
    for (const release of filtered) {
      const key = releaseGroup(release);
      const bucket = byYear.get(key);
      if (bucket) bucket.push(release);
      else byYear.set(key, [release]);
    }
    return [...byYear.entries()];
  }, [filtered]);

  // Years more than two back start folded, so the list opens on what is
  // current rather than on a decade of hotfixes. Decided while rendering, not
  // in an effect after it: the effect let the list paint with every year
  // open and fold a frame later, which was the list jumping on load. A
  // search looks through folded years too: a match hidden inside a closed
  // group read as no match at all.
  const cutoffYear = new Date().getFullYear() - 2;
  const foldedByDefault = (groupKey: string) => {
    if (groupKey === UNDATED_GROUP || groupKey === LEGACY_GROUP) return true;
    const year = Number.parseInt(groupKey, 10);
    return Number.isFinite(year) && year <= cutoffYear;
  };
  const isCollapsed = (groupKey: string) =>
    !query && foldedByDefault(groupKey) !== toggledGroups.has(groupKey);

  // The rows the keyboard walks, in the order they are drawn.
  const visibleReleases = groups.flatMap(([year, releases]) =>
    isCollapsed(year || BRANCH_GROUP) ? [] : releases,
  );

  const entry = changelog.entries[changelog.selected];
  const selectedIndex = changelog.releases.findIndex((release) => release.id === changelog.selected);
  const selected = selectedIndex >= 0 ? changelog.releases[selectedIndex] : undefined;
  const newer = selectedIndex > 0 ? changelog.releases[selectedIndex - 1] : undefined;
  const older = selectedIndex >= 0 ? changelog.releases[selectedIndex + 1] : undefined;
  const loadingEntry = changelog.entryStatus.type === "loading";
  const selectedGroup = selected ? releaseGroup(selected) : null;
  const selectedFoldedByDefault = selectedGroup !== null && foldedByDefault(selectedGroup);
  const selectedGroupFolded = selectedGroup !== null
    && selectedFoldedByDefault !== toggledGroups.has(selectedGroup);

  const heading = useMemo(
    () => noteTitle(entry?.blocks ?? [], entry?.title || selected?.id || "", Boolean(selected?.date)),
    [entry, selected],
  );

  const illustrations = useMemo(() => bundledNoteIllustrations(entry), [entry]);
  const sections = useMemo<Section[]>(
    () => (entry ? noteSections(entry.blocks, heading.skipFirst, t("changelog.historicalBalance"), 0, illustrations) : []),
    [entry, heading.skipFirst, t, illustrations],
  );
  const { scrollRef, tocRef, activeSectionId, onNoteScroll, jumpTo } = useNoteContents(sections, changelog.selected, "game", Boolean(entry));

  useEffect(() => {
    if (!jumpTarget || entry?.id !== jumpTarget.releaseId || loadingEntry) return;
    const frame = requestAnimationFrame(() => {
      const [first, ...nested] = jumpTarget.blockPath;
      jumpTo([anchorFor(first ?? 0), ...nested].join("-"));
      onJumped();
    });
    return () => cancelAnimationFrame(frame);
  }, [entry, jumpTarget, loadingEntry, jumpTo, onJumped]);

  useLayoutEffect(() => {
    if (listedSelection.current === changelog.selected || selectedGroup === null) return;
    // A search result or the next/previous controls can choose a folded year.
    // Open it before measuring the row, including while a filter shows it,
    // so clearing that filter does not hide the selection again. A remount
    // of the same note preserves the reader's manual folds and list offset.
    if (selectedGroupFolded) {
      // Set, not flip: a development build runs this effect twice on mount,
      // and two flips would leave the year folded.
      setToggledGroups(current => {
        const next = new Set(current);
        if (selectedFoldedByDefault) next.add(selectedGroup);
        else next.delete(selectedGroup);
        changelogViewMemory.game.years = next;
        return next;
      });
      return;
    }
    keepCurrentRowInView(listRef.current);
    listedSelection.current = changelog.selected;
  }, [changelog.selected, selectedGroup, selectedGroupFolded, selectedFoldedByDefault]);

  const select = (id: string) =>
    ipc.send({ kind: "Changelog", command: { type: "select", payload: { id } } });

  const toggleGroup = (groupKey: string) => {
    setToggledGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      changelogViewMemory.game.years = next;
      return next;
    });
  };

  // Up and down walk the list and open what they land on, the way a reader
  // pages through patches; focus follows so the next press continues from
  // there.
  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const target = event.target as HTMLElement;
    const id = target.dataset.releaseId;
    if (!id) return;
    const index = visibleReleases.findIndex((release) => release.id === id);
    const next = visibleReleases[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    select(next.id);
    listRef.current?.querySelector<HTMLElement>(`[data-release-id="${CSS.escape(next.id)}"]`)?.focus();
  };

  if (changelog.status.type === "failed") {
    return (
      <div className="changelog-view">
        <EmptyState
          icon="changelog"
          title={t("changelog.failed.title")}
          // Plainly, with the system's own wording kept on hover for a bug
          // report: the raw reason was an HTTP client's English.
          hint={
            <span title={changelog.status.payload.reason}>
              {plainError(changelog.status.payload.reason)}
            </span>
          }
        >
          <Button
            variant="primary"
            onClick={() => ipc.send({ kind: "Changelog", command: { type: "load" } })}
          >
            {t("changelog.retry")}
          </Button>
        </EmptyState>
      </div>
    );
  }

  const longDate = selected?.date
    ? formatDate(selected.date, "", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    : "";

  return (
    <div className="changelog-view">
      <aside className="changelog-sidebar surface-panel">
        <div className="search-field changelog-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("changelog.searchPlaceholder")}
            aria-label={t("changelog.searchAria")}
          />
        </div>

        {/* Without the current list, the notes bundled with the client are
            still readable; the failure is said above them, not instead of
            them. */}
        {changelog.indexUnavailable && (
          <StatusNotice
            tone="info"
            className="changelog-index-notice"
            action={{
              label: t("changelog.retry"),
              onClick: () => ipc.send({ kind: "Changelog", command: { type: "load" } }),
            }}
            detail={changelog.indexUnavailable}
          >
            {t("changelog.indexUnavailable")}
          </StatusNotice>
        )}

        <nav
          ref={listRef}
          onScroll={onListScroll}
          className="changelog-releases"
          aria-label={t("changelog.releases")}
          onKeyDown={onListKeyDown}
        >
          {changelog.status.type === "loading" && changelog.releases.length === 0 && (
            <p className="changelog-list-note">{t("changelog.loading")}</p>
          )}
          {changelog.status.type === "ready" && filtered.length === 0 && (
            <p className="changelog-list-note">{t("changelog.noMatch")}</p>
          )}

          {groups.map(([year, releases]) => {
            const groupKey = year || BRANCH_GROUP;
            const collapsed = isCollapsed(groupKey);
            const isBranchGroup = groupKey === BRANCH_GROUP;
            const groupId = `changelog-group-${groupKey || "branches"}`;

            return (
              <section key={groupKey || "branches"} className="changelog-year">
                <button
                  type="button"
                  className="changelog-year-toggle"
                  aria-expanded={!collapsed}
                  aria-controls={groupId}
                  onClick={() => toggleGroup(groupKey)}
                >
                  <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={13} />
                  <span>{groupKey === UNDATED_GROUP ? t("changelog.historical.undated")
                    : groupKey === LEGACY_GROUP ? t("changelog.historical.legacy") : year || t("changelog.branches")}</span>
                  <span className="changelog-year-count">{releases.length}</span>
                </button>
                <ul id={groupId} className="changelog-year-releases" hidden={collapsed}>
                  {releases.map((release) => {
                    const current = release.id === changelog.selected;
                    const branchInfo = isBranchGroup
                      ? release.id === "fafbeta"
                        ? t("lobby.host.mod.fafbetaDesc")
                        : release.id === "fafdevelop"
                          ? t("lobby.host.mod.fafdevelopDesc")
                          : null
                      : null;
                    const patch = isPatch(release.kind);
                    return (
                      <li key={release.id}>
                        <button
                          type="button"
                          data-release-id={release.id}
                          aria-current={current ? "page" : undefined}
                          className={`changelog-release${patch ? " is-patch" : ""}${isBranchGroup ? " is-branch" : ""}`}
                          onClick={() => select(release.id)}
                        >
                          {isBranchGroup ? (
                            // The mark the host dialog shows for the same
                            // featured mod, so the branch is recognisable
                            // from the lobby.
                            <>
                              <FeaturedModIcon modId={release.id} className="changelog-release-icon" tint />
                              <span className="changelog-release-text">
                                <span className="changelog-release-id">{release.id}</span>
                                {branchInfo && (
                                  <span className="changelog-release-note" title={branchInfo}>{branchInfo}</span>
                                )}
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="changelog-release-id">{releaseLabel(release.id)}</span>
                              <span className="changelog-release-kind" title={kindLabel(release.kind, t)}>{kindLabel(release.kind, t)}</span>
                              <span className="changelog-release-date">{listDate(release.date)}</span>
                            </>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </nav>
      </aside>

      <article className="changelog-note surface-panel" aria-busy={loadingEntry || undefined}>
        {selected && (
          <header className="changelog-note-head">
            <div className="changelog-note-heading">
              <h1>{entry ? heading.title : releaseLabel(selected.id)}</h1>
              <p className="changelog-note-meta">
                {!isRollingRelease(selected) && (
                  <span className={`changelog-kind-tag${isPatch(selected.kind) ? " is-patch" : ""}`}>
                    {kindLabel(selected.kind, t)}
                  </span>
                )}
                {longDate && <time dateTime={selected.date}>{longDate}</time>}
                {!selected.date && !isRollingRelease(selected) && <span>{t("changelog.historical.dateUnknown")}</span>}
              </p>
            </div>
            <div className="changelog-note-actions">
              <div className="changelog-step" role="group">
                <button
                  type="button"
                  className="changelog-step-btn"
                  disabled={!newer}
                  onClick={() => newer && select(newer.id)}
                  title={newer ? `${t(selected.date && newer.date ? "changelog.newer" : "changelog.historical.previous")}: ${releaseLabel(newer.id)}` : t("changelog.newer")}
                  aria-label={t(selected.date && newer?.date ? "changelog.newer" : "changelog.historical.previous")}
                >
                  <Icon name="chevronUp" size={15} />
                </button>
                <button
                  type="button"
                  className="changelog-step-btn"
                  disabled={!older}
                  onClick={() => older && select(older.id)}
                  title={older ? `${t(selected.date && older.date ? "changelog.older" : "changelog.historical.next")}: ${releaseLabel(older.id)}` : t("changelog.older")}
                  aria-label={t(selected.date && older?.date ? "changelog.older" : "changelog.historical.next")}
                >
                  <Icon name="chevronDown" size={15} />
                </button>
              </div>
              <Button className="changelog-external" aria-label={t("changelog.openOnSite")} title={t("changelog.openOnSite")}
                onClick={() => ipc.run(openChangelogLink(selected.webUrl))}>
                <Icon name="external" size={13} />
                <span>{t("changelog.openOnSite")}</span>
              </Button>
            </div>
          </header>
        )}
        {/* The header's shape while the list is still loading and nothing is
            selected yet. Without it the header appeared with the first patch
            and pushed the reading area down by its own height. */}
        {!selected && changelog.status.type !== "ready" && (
          <header className="changelog-note-head" aria-hidden="true">
            <div className="changelog-note-heading changelog-head-skeleton">
              <span />
              <span />
            </div>
          </header>
        )}

        <div className="changelog-note-scroll" ref={scrollRef} onScroll={onNoteScroll}>
          <div className={`changelog-note-layout${showsContents(sections) ? " has-toc" : ""}`}>
            <div className="changelog-note-copy">
              <NoteJumpRow sections={sections} onJump={jumpTo} />

              {loadingEntry && !entry && (
                <div className="changelog-skeleton" aria-label={t("changelog.loadingNote")}>
                  <span /><span /><span /><span className="is-short" />
                </div>
              )}

              {changelog.entryStatus.type === "failed" && !entry && selected && (
                <StatusNotice
                  tone="error"
                  action={{ label: t("changelog.retry"), onClick: () => select(selected.id) }}
                  detail={changelog.entryStatus.payload.reason}
                >
                  {plainError(changelog.entryStatus.payload.reason)}
                </StatusNotice>
              )}

              {!selected && changelog.status.type === "ready" && (
                <p className="changelog-list-note">{t("changelog.pick")}</p>
              )}

              {entry && <NoteBlocks blocks={entry.blocks} skipFirst={heading.skipFirst} illustrations={illustrations} />}
            </div>

            {showsContents(sections) && (
              <NoteContentsColumn
                sections={sections}
                activeSectionId={activeSectionId}
                navRef={tocRef}
                onJump={jumpTo}
              />
            )}
          </div>
        </div>
      </article>
    </div>
  );
}
