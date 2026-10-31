// This client's own releases, the Changelog tab's second section.
//
// The notes arrive in the same GitHub response the update check reads (see
// `ClientUpdateCommand::LoadNotes`), parsed by the same parser as a game
// patch, and are read the same way: the releases in a list, one release's
// note beside it, with its categories (Highlights when it has them, then
// Features, Bug fixes, ...) as the note's contents. Which release is open is
// the backend's
// (`nav.changelogClientVersion`), so the update banner and the What's new
// popup can open the tab on one.

import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { Icon } from "../../design-system/Icon";
import { StatusNotice } from "../../design-system/StatusNotice";
import type { ChangelogBlock, ChangelogListItem, ChangelogSpan, ClientReleaseNotes } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { openChangelogLink } from "../../shared/changelogLinks";
import { useTranslation } from "../../i18n/useTranslation";
import { useRememberedFilter } from "../../shared/filterMemory";
import { formatDate } from "../../shared/format/dates";
import { plainError } from "../../shared/plainError";
import { useAppStore } from "../../store/store";
import {
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
import "./changelog.css";
import { changelogViewMemory } from "./viewMemory";

const loadNotes = () => ipc.send({ kind: "ClientUpdate", command: { type: "loadNotes" } });

const select = (version: string) =>
  ipc.send({ kind: "Nav", command: { type: "selectChangelogClientRelease", payload: { version } } });

/** How a release is named in the list, the way the status bar names the build. */
const versionLabel = (version: string) => `v${version}`;

/** The list has no year groups to carry the year, so its dates do. */
function listDate(publishedAt: string | null): string {
  return formatDate(publishedAt ?? "", "", { day: "numeric", month: "short", year: "numeric" });
}

function longDate(publishedAt: string | null): string {
  return formatDate(publishedAt ?? "", "", { day: "numeric", month: "long", year: "numeric" });
}

function spanText(span: ChangelogSpan): string {
  switch (span.type) {
    case "link":
      return span.payload.text;
    case "issue":
      return `#${span.payload.number}`;
    default:
      return span.payload;
  }
}

/** Every word of a release's note, for the search box. */
function noteText(blocks: ChangelogBlock[]): string {
  const items = (list: ChangelogListItem[]): string[] =>
    list.flatMap((item) => [item.spans.map(spanText).join(""), ...items(item.children)]);
  return blocks
    .flatMap((block) => {
      switch (block.type) {
        case "heading":
        case "codeBlock":
          return [block.payload.text];
        case "unit":
          return [block.payload.name];
        case "list":
          return items(block.payload.items);
        case "historicalBalance":
          return [noteText(block.payload.blocks)];
        case "provenance":
          return [];
        default:
          return [block.payload.spans.map(spanText).join("")];
      }
    })
    .join("\n");
}

/**
 * The note with its headings moved up so the shallowest is a section.
 *
 * A release writes its categories as `###`, one level below where a game
 * patch puts its sections, so read as they are they would all be
 * sub-sections: the contents would indent them and the jump row would have
 * nothing to show.
 */
function asSections(blocks: ChangelogBlock[]): ChangelogBlock[] {
  const levels = blocks.flatMap((block) => (block.type === "heading" ? [block.payload.level] : []));
  const shift = levels.length > 0 ? Math.min(...levels) - 2 : 0;
  if (shift <= 0) return blocks;
  return blocks.map((block) =>
    block.type === "heading"
      ? { ...block, payload: { ...block.payload, level: block.payload.level - shift } }
      : block,
  );
}

/** What a release is to this install: the one running, the one on offer, a pre-release. */
function ReleaseTags({ note, installed, offered }: {
  note: ClientReleaseNotes;
  installed: string;
  offered: string | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      {note.version === installed && (
        <span className="vault-badge is-ok">{t("changelog.client.installed")}</span>
      )}
      {note.version === offered && (
        <span className="vault-badge is-accent">{t("changelog.client.updateAvailable")}</span>
      )}
      {note.preRelease && <span className="vault-badge">{t("changelog.client.preRelease")}</span>}
    </>
  );
}

export function ClientReleasesView() {
  const { t } = useTranslation();
  const notes = useAppStore((state) => state.state.clientUpdate.notes);
  const status = useAppStore((state) => state.state.clientUpdate.notesStatus);
  const currentVersion = useAppStore((state) => state.state.clientUpdate.currentVersion);
  const backendVersion = useAppStore((state) => state.state.session.backendVersion);
  const offered = useAppStore((state) => state.state.clientUpdate.release?.version ?? null);
  const chosen = useAppStore((state) => state.state.nav.changelogClientVersion);
  // Remembered as the filter setting says (#447), apart from the game list's.
  const [search, setSearch] = useRememberedFilter("changelog.clientSearch", "", (value) => typeof value === "string");
  const listRef = useRef<HTMLElement>(null);
  const listedSelection = useRef(changelogViewMemory.client.position?.selection);
  const onListScroll = useNoteListPosition(listRef, "client", status.type === "ready");

  // Cheap after the startup check, which has read the list already.
  useEffect(() => {
    loadNotes();
  }, []);

  // The update check reports the running version; before it has run, the
  // version the backend announced itself with is the same build.
  const installed = currentVersion || backendVersion;

  const searchable = useMemo(
    () => new Map(notes.map((note) => [note.version, `${versionLabel(note.version)}\n${noteText(note.blocks)}`.toLocaleLowerCase()])),
    [notes],
  );
  const query = search.trim().toLocaleLowerCase();
  const filtered = useMemo(
    () => (query ? notes.filter((note) => searchable.get(note.version)?.includes(query)) : notes),
    [notes, query, searchable],
  );

  // The release asked for, or the newest when none was, or when the one asked
  // for is not in the list.
  const chosenIndex = chosen === null ? -1 : notes.findIndex((note) => note.version === chosen);
  const selectedIndex = chosenIndex >= 0 ? chosenIndex : notes.length > 0 ? 0 : -1;
  const selected = selectedIndex >= 0 ? notes[selectedIndex] : undefined;
  const newer = selectedIndex > 0 ? notes[selectedIndex - 1] : undefined;
  const older = selectedIndex >= 0 ? notes[selectedIndex + 1] : undefined;
  const selection = selected?.version ?? "";

  const blocks = useMemo(() => asSections(selected?.blocks ?? []), [selected]);
  const sections = useMemo<Section[]>(
    () => noteSections(blocks, false, t("changelog.historicalBalance")),
    [blocks, t],
  );
  const { scrollRef, tocRef, activeSectionId, onNoteScroll, jumpTo } = useNoteContents(sections, selection, "client", Boolean(selected));

  useEffect(() => {
    if (listedSelection.current !== selection) keepCurrentRowInView(listRef.current);
    listedSelection.current = selection;
  }, [selection]);

  // Up and down walk the list and open what they land on, as in the game
  // patches' list.
  const onListKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const version = (event.target as HTMLElement).dataset.releaseVersion;
    if (!version) return;
    const index = filtered.findIndex((note) => note.version === version);
    const next = filtered[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    select(next.version);
    listRef.current?.querySelector<HTMLElement>(`[data-release-version="${CSS.escape(next.version)}"]`)?.focus();
  };

  // A list already on screen is never replaced by a failure (the reducer
  // keeps it), so a failure here means there is nothing to show at all.
  if (status.type === "failed") {
    return (
      <div className="changelog-view">
        <EmptyState
          icon="changelog"
          title={t("changelog.client.failed.title")}
          hint={<span title={status.payload.reason}>{plainError(status.payload.reason)}</span>}
        >
          <Button variant="primary" onClick={loadNotes}>
            {t("changelog.retry")}
          </Button>
        </EmptyState>
      </div>
    );
  }

  if (status.type === "ready" && notes.length === 0) {
    return (
      <div className="changelog-view">
        <EmptyState icon="changelog" title={t("changelog.client.empty")} />
      </div>
    );
  }

  const loading = status.type !== "ready";
  const openOnGithub = (note: ClientReleaseNotes) => ipc.run(openChangelogLink(note.notesUrl));

  return (
    <div className="changelog-view">
      <aside className="changelog-sidebar surface-panel">
        <div className="search-field changelog-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("changelog.client.searchPlaceholder")}
            aria-label={t("changelog.client.searchAria")}
          />
        </div>

        <nav
          ref={listRef}
          onScroll={onListScroll}
          className="changelog-releases"
          aria-label={t("changelog.client.releases")}
          onKeyDown={onListKeyDown}
        >
          {loading && <p className="changelog-list-note">{t("changelog.client.loading")}</p>}
          {!loading && filtered.length === 0 && (
            <p className="changelog-list-note">{t("changelog.client.noMatch")}</p>
          )}

          <ul className="changelog-client-releases">
            {filtered.map((note) => {
              const date = listDate(note.publishedAt);
              return (
                <li key={note.version}>
                  <button
                    type="button"
                    data-release-version={note.version}
                    aria-current={note.version === selection ? "page" : undefined}
                    className="changelog-release is-client"
                    onClick={() => select(note.version)}
                  >
                    <span className="changelog-client-line">
                      <span className="changelog-release-id">{versionLabel(note.version)}</span>
                      {date && <span className="changelog-release-date">{date}</span>}
                    </span>
                    <span className="changelog-client-tags">
                      <ReleaseTags note={note} installed={installed} offered={offered} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <article className="changelog-note surface-panel" aria-busy={loading || undefined}>
        {selected ? (
          <header className="changelog-note-head">
            <div className="changelog-note-heading">
              <h1>{t("changelog.client.title", { version: selected.version })}</h1>
              <p className="changelog-note-meta">
                <ReleaseTags note={selected} installed={installed} offered={offered} />
                {selected.publishedAt && (
                  <time dateTime={selected.publishedAt}>{longDate(selected.publishedAt)}</time>
                )}
              </p>
            </div>
            <div className="changelog-note-actions">
              <div className="changelog-step" role="group">
                <button
                  type="button"
                  className="changelog-step-btn"
                  disabled={!newer}
                  onClick={() => newer && select(newer.version)}
                  title={newer ? `${t("changelog.client.newer")}: ${versionLabel(newer.version)}` : t("changelog.client.newer")}
                  aria-label={t("changelog.client.newer")}
                >
                  <Icon name="chevronUp" size={15} />
                </button>
                <button
                  type="button"
                  className="changelog-step-btn"
                  disabled={!older}
                  onClick={() => older && select(older.version)}
                  title={older ? `${t("changelog.client.older")}: ${versionLabel(older.version)}` : t("changelog.client.older")}
                  aria-label={t("changelog.client.older")}
                >
                  <Icon name="chevronDown" size={15} />
                </button>
              </div>
              <Button className="changelog-external" aria-label={t("changelog.client.openOnGithub")} title={t("changelog.client.openOnGithub")}
                onClick={() => openOnGithub(selected)}>
                <Icon name="external" size={13} />
                <span>{t("changelog.client.openOnGithub")}</span>
              </Button>
            </div>
          </header>
        ) : (
          // The header's shape until the list arrives, as in the game
          // patches, so the reading area does not move down when it does.
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

              {loading && !selected && (
                <div className="changelog-skeleton" aria-label={t("changelog.client.loadingNote")}>
                  <span /><span /><span /><span className="is-short" />
                </div>
              )}

              {/* Every release before the changelog snippets was published
                  with nothing but the installer line, which the parser drops. */}
              {selected && blocks.length === 0 && (
                <StatusNotice
                  tone="info"
                  action={{ label: t("changelog.client.openOnGithub"), onClick: () => openOnGithub(selected) }}
                >
                  {t("changelog.client.noNotes")}
                </StatusNotice>
              )}

              <NoteBlocks blocks={blocks} />
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
