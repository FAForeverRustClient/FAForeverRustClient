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

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import { formatDate } from "../../shared/format/dates";
import { FeaturedModIcon } from "../../shared/components/FeaturedModIcon";
import type {
  ChangelogBlock,
  ChangelogListItem,
  ChangelogRelease,
  ChangelogSpan,
} from "../../ipc/bindings";
import "./changelog.css";

/** Rolling branches have no date and belong above the dated years. */
const BRANCH_GROUP = "";

/** A section of the open note, as the contents list and the jump row name it. */
interface Section {
  id: string;
  text: string;
  /** 1 for a section heading, 2 for what sits inside one (a unit, a sub-heading). */
  depth: 1 | 2;
}

type Translate = ReturnType<typeof useTranslation>["t"];

/** The upstream kind, in the reader's language where the client knows it. */
// The upstream kinds, compared without regard to case: they come from the
// site's post titles ("3837 - Game Patch").
const isPatch = (kind: string) => kind.toLowerCase() === "game patch";
const isHotfix = (kind: string) => kind.toLowerCase() === "hotfix";

function kindLabel(kind: string, t: Translate): string {
  if (isPatch(kind)) return t("changelog.kind.patch");
  if (isHotfix(kind)) return t("changelog.kind.hotfix");
  return kind;
}

/** Day and month only: the list already groups by year. */
function listDate(date: string): string {
  return formatDate(date, "", { day: "numeric", month: "short" });
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

function Spans({ spans }: { spans: ChangelogSpan[] }) {
  return (
    <>
      {spans.map((span, index) => {
        switch (span.type) {
          case "strong":
            return <strong key={index}>{span.payload}</strong>;
          case "code":
            return <code key={index}>{span.payload}</code>;
          case "link":
            return (
              <button
                key={index}
                type="button"
                className="changelog-link"
                title={span.payload.url}
                onClick={() => void native.openUrl(span.payload.url)}
              >
                {span.payload.text}
              </button>
            );
          case "issue":
            return (
              <button
                key={index}
                type="button"
                className="changelog-issue"
                title={span.payload.url}
                onClick={() => void native.openUrl(span.payload.url)}
              >
                #{span.payload.number}
              </button>
            );
          default:
            return <span key={index}>{span.payload}</span>;
        }
      })}
    </>
  );
}

function ListItems({ items }: { items: ChangelogListItem[] }) {
  return (
    <ul className="changelog-list">
      {items.map((item, index) => (
        <li key={index}>
          {item.change ? (
            // A value change reads as a diff, the way the site styles it: the
            // strike and the arrow say which is which before the colour does.
            <span className="changelog-change">
              <span className="changelog-change-label">{item.change.label}</span>
              <span className="changelog-old">{item.change.old}</span>
              <Icon name="arrowRight" size={12} />
              <span className="changelog-new">{item.change.new}</span>
            </span>
          ) : (
            <Spans spans={item.spans} />
          )}
          {item.children.length > 0 && <ListItems items={item.children} />}
        </li>
      ))}
    </ul>
  );
}

function Block({ block, anchorId }: { block: ChangelogBlock; anchorId: string }) {
  switch (block.type) {
    case "heading": {
      // The page title is the one `h1`; the note's sections start at `h2`.
      const level = Math.min(Math.max(block.payload.level, 2), 4);
      const Tag = `h${level}` as "h2" | "h3" | "h4";
      return (
        <Tag id={anchorId} className={`changelog-heading changelog-heading-${level}`}>
          {block.payload.text}
        </Tag>
      );
    }
    case "unit":
      return (
        <div id={anchorId} className="changelog-unit">
          <span className="changelog-unit-icons">
            {block.payload.units.map((unit) => (
              <img
                key={unit.unitId}
                className="changelog-unit-icon"
                src={unit.iconUrl}
                alt=""
                title={unit.unitId}
                loading="lazy"
                draggable={false}
                /* Older notes name units the site never drew an icon for, and a
                   missing sprite should leave a gap rather than a broken image. */
                onError={(event) => event.currentTarget.classList.add("is-missing")}
              />
            ))}
          </span>
          <span className="changelog-unit-name">{block.payload.name}</span>
        </div>
      );
    case "list":
      return <ListItems items={block.payload.items} />;
    default:
      return (
        <p className="changelog-paragraph">
          <Spans spans={block.payload.spans} />
        </p>
      );
  }
}

const anchorFor = (index: number) => `changelog-block-${index}`;

export function ChangelogView() {
  const { t } = useTranslation();
  const changelog = useAppStore((state) => state.state.changelog);
  const [search, setSearch] = useState("");
  /// The years the reader has flipped from their default, folded or open.
  const [toggledGroups, setToggledGroups] = useState<Set<string>>(() => new Set());
  const [activeSectionId, setActiveSectionId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tocRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const isClickScrolling = useRef(false);
  const clickScrollTimeout = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (clickScrollTimeout.current) clearTimeout(clickScrollTimeout.current);
    };
  }, []);

  useEffect(() => {
    ipc.send({ kind: "Changelog", command: { type: "load" } });
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
      const key = release.year || BRANCH_GROUP;
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

  const heading = useMemo(
    () => noteTitle(entry?.blocks ?? [], entry?.title || selected?.id || "", Boolean(selected?.date)),
    [entry, selected],
  );

  const sections = useMemo<Section[]>(() => {
    if (!entry) return [];
    return entry.blocks.flatMap((block, index): Section[] => {
      if (heading.skipFirst && index === 0) return [];
      if (block.type === "heading" && block.payload.level <= 3) {
        return [{ id: anchorFor(index), text: block.payload.text, depth: block.payload.level <= 2 ? 1 : 2 }];
      }
      if (block.type === "unit") return [{ id: anchorFor(index), text: block.payload.name, depth: 2 }];
      return [];
    });
  }, [entry, heading.skipFirst]);
  const topSections = sections.filter((section) => section.depth === 1);

  // A new note opens at its top at once, not after a long smooth scroll.
  // Keyed on the selection alone: keyed on the section list too, any store
  // update that rebuilt the list threw the reader back to the top, and cut
  // short a jump that was still gliding.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "instant" });
    setActiveSectionId(null);
  }, [changelog.selected]);

  // The first section is the current one until the reader moves, and a
  // rebuilt list keeps the current one if it still has it.
  useEffect(() => {
    setActiveSectionId((current) =>
      current && sections.some((section) => section.id === current) ? current : sections[0]?.id ?? null,
    );
  }, [sections]);

  // The selected row is kept in view, whichever way it was chosen: a click,
  // the arrow keys, or the newer and older buttons over the note. By hand, on
  // the list alone: `scrollIntoView` also scrolls every container around the
  // list, and the first selection, which lands as the tab loads, could nudge
  // the whole page. The top allowance keeps the row clear of the sticky year
  // heading.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(".changelog-release[aria-current='page']");
    if (!list || !row) return;
    const bounds = list.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < bounds.top + 36) list.scrollTop -= bounds.top + 36 - rect.top;
    else if (rect.bottom > bounds.bottom) list.scrollTop += rect.bottom - bounds.bottom;
  }, [changelog.selected]);

  const handleNoteScroll = () => {
    if (isClickScrolling.current) return;
    const container = scrollRef.current;
    if (!container || sections.length === 0) return;
    if (container.scrollHeight - container.scrollTop - container.clientHeight <= 24) {
      setActiveSectionId(sections[sections.length - 1].id);
      return;
    }
    const containerTop = container.getBoundingClientRect().top;
    let currentId = sections[0].id;
    for (const section of sections) {
      const element = document.getElementById(section.id);
      if (!element) continue;
      if (element.getBoundingClientRect().top - containerTop <= 72) currentId = section.id;
      else break;
    }
    setActiveSectionId(currentId);
  };

  // The contents column scrolls on its own when a note has many units, and
  // follows the reader so the highlighted entry never leaves it. By hand,
  // on the column alone: `scrollIntoView` scrolls every scrollable ancestor,
  // and the column sits inside the note's scroll, so it cancelled the smooth
  // scroll a click on an entry had just started.
  useEffect(() => {
    const nav = tocRef.current;
    const item = nav?.querySelector<HTMLElement>(".changelog-toc-item.is-active");
    if (!nav || !item) return;
    const bounds = nav.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    if (rect.bottom > bounds.bottom) nav.scrollTop += rect.bottom - bounds.bottom + 8;
    else if (rect.top < bounds.top) nav.scrollTop -= bounds.top - rect.top + 8;
  }, [activeSectionId]);

  const jumpTo = (id: string) => {
    setActiveSectionId(id);
    isClickScrolling.current = true;
    if (clickScrollTimeout.current) clearTimeout(clickScrollTimeout.current);
    clickScrollTimeout.current = window.setTimeout(() => {
      isClickScrolling.current = false;
    }, 800);
    const element = document.getElementById(id);
    const container = scrollRef.current;
    if (!element || !container) return;
    const offset = element.getBoundingClientRect().top - container.getBoundingClientRect().top;
    // Smooth or instant per the stylesheet's `scroll-behavior`, which
    // honours a request for reduced motion.
    container.scrollTo({ top: Math.max(0, container.scrollTop + offset - 16) });
  };

  const select = (id: string) =>
    ipc.send({ kind: "Changelog", command: { type: "select", payload: { id } } });

  const toggleGroup = (groupKey: string) => {
    setToggledGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
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
          hint={changelog.status.payload.reason}
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
    ? formatDate(selected.date, "", { day: "numeric", month: "long", year: "numeric" })
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

        <nav
          ref={listRef}
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
                  <span>{year || t("changelog.branches")}</span>
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
                              <span className="changelog-release-id">{release.id}</span>
                              <span className="changelog-release-kind">{kindLabel(release.kind, t)}</span>
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
              <h1>{entry ? heading.title : selected.id}</h1>
              <p className="changelog-note-meta">
                {selected.year && (
                  <span className={`changelog-kind-tag${isPatch(selected.kind) ? " is-patch" : ""}`}>
                    {kindLabel(selected.kind, t)}
                  </span>
                )}
                {longDate && <time dateTime={selected.date}>{longDate}</time>}
              </p>
            </div>
            <div className="changelog-note-actions">
              <div className="changelog-step" role="group">
                <button
                  type="button"
                  className="changelog-step-btn"
                  disabled={!newer}
                  onClick={() => newer && select(newer.id)}
                  title={newer ? `${t("changelog.newer")}: ${newer.id}` : t("changelog.newer")}
                  aria-label={t("changelog.newer")}
                >
                  <Icon name="chevronUp" size={15} />
                </button>
                <button
                  type="button"
                  className="changelog-step-btn"
                  disabled={!older}
                  onClick={() => older && select(older.id)}
                  title={older ? `${t("changelog.older")}: ${older.id}` : t("changelog.older")}
                  aria-label={t("changelog.older")}
                >
                  <Icon name="chevronDown" size={15} />
                </button>
              </div>
              <Button className="changelog-external" onClick={() => void native.openUrl(selected.webUrl)}>
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

        <div className="changelog-note-scroll" ref={scrollRef} onScroll={handleNoteScroll}>
          <div className={`changelog-note-layout${sections.length > 0 ? " has-toc" : ""}`}>
            <div className="changelog-note-copy">
              {/* The sections as a row of jump links, for a surface too narrow
                  for the contents column. Only the top level: units are many,
                  and a wrapped row of thirty names is not a way to find one. */}
              {topSections.length > 1 && (
                <nav className="changelog-jump" aria-label={t("changelog.contents")}>
                  {topSections.map((section) => (
                    <button
                      key={section.id}
                      type="button"
                      className="changelog-jump-item"
                      onClick={() => jumpTo(section.id)}
                    >
                      {section.text}
                    </button>
                  ))}
                </nav>
              )}

              {loadingEntry && !entry && (
                <div className="changelog-skeleton" aria-label={t("changelog.loadingNote")}>
                  <span /><span /><span /><span className="is-short" />
                </div>
              )}

              {changelog.entryStatus.type === "failed" && !entry && selected && (
                <div className="changelog-note-failed" role="alert">
                  <p>{changelog.entryStatus.payload.reason}</p>
                  <Button onClick={() => select(selected.id)}>
                    <Icon name="refresh" size={13} />
                    <span>{t("changelog.retry")}</span>
                  </Button>
                </div>
              )}

              {!selected && changelog.status.type === "ready" && (
                <p className="changelog-list-note">{t("changelog.pick")}</p>
              )}

              {entry?.blocks.map((block, index) =>
                heading.skipFirst && index === 0 ? null : (
                  <Block key={index} block={block} anchorId={anchorFor(index)} />
                ),
              )}
            </div>

            {sections.length > 0 && (
              <nav className="changelog-toc" ref={tocRef} aria-label={t("changelog.contents")}>
                <p className="changelog-toc-title">{t("changelog.contents")}</p>
                <ul className="changelog-toc-list">
                  {sections.map((section) => (
                    <li key={section.id}>
                      <button
                        type="button"
                        className={`changelog-toc-item depth-${section.depth}${
                          activeSectionId === section.id ? " is-active" : ""
                        }`}
                        aria-current={activeSectionId === section.id ? "location" : undefined}
                        title={section.depth === 2 ? section.text : undefined}
                        onClick={() => jumpTo(section.id)}
                      >
                        {section.text}
                      </button>
                    </li>
                  ))}
                </ul>
              </nav>
            )}
          </div>
        </div>
      </article>
    </div>
  );
}
