// Patch notes from FAForever/fa, rendered in the client's own chrome.
//
// The published site is a light-themed Jekyll page, so an iframe would drop a
// white document into a dark client. The backend parses the same source into
// blocks (see faf-domain's `protocol::changelog`) and this renders them, which
// also means the unit icons, balance diffs and issue links keep their meaning
// instead of arriving as a wall of text.

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { native } from "../../ipc/native";
import { useAppStore } from "../../store/store";
import { useTranslation } from "../../i18n/useTranslation";
import type {
  ChangelogBlock,
  ChangelogListItem,
  ChangelogRelease,
  ChangelogSpan,
} from "../../ipc/bindings";
import "./changelog.css";

/** Rolling branches have no date and belong above the dated years. */
const BRANCH_GROUP = "";

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
            // A value change reads as a diff, the way the site styles it.
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

function Block({ block }: { block: ChangelogBlock }) {
  switch (block.type) {
    case "heading": {
      const level = Math.min(Math.max(block.payload.level, 1), 4);
      // The post's own `# Game version …` is already the panel's title, so its
      // headings start one step down rather than competing with it.
      return (
        <p className={`changelog-heading changelog-heading-${level}`}>{block.payload.text}</p>
      );
    }
    case "unit":
      return (
        <div className="changelog-unit">
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

export function ChangelogView() {
  const { t } = useTranslation();
  const changelog = useAppStore((state) => state.state.changelog);
  const [search, setSearch] = useState("");

  useEffect(() => {
    ipc.send({ kind: "Changelog", command: { type: "load" } });
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return changelog.releases;
    return changelog.releases.filter(
      (release) =>
        release.id.toLocaleLowerCase().includes(query) ||
        release.kind.toLocaleLowerCase().includes(query) ||
        release.date.includes(query),
    );
  }, [changelog.releases, search]);

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

  const entry = changelog.entries[changelog.selected];
  const selected = changelog.releases.find((release) => release.id === changelog.selected);
  const loadingEntry = changelog.entryStatus.type === "loading";

  const select = (id: string) =>
    ipc.send({ kind: "Changelog", command: { type: "select", payload: { id } } });

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

  return (
    <div className="changelog-view">
      <aside className="changelog-sidebar surface-panel">
        <div className="search-field changelog-search">
          <Icon name="search" size={13} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("changelog.searchPlaceholder")}
            aria-label={t("changelog.searchAria")}
          />
        </div>

        <div className="changelog-releases" role="listbox" aria-label={t("changelog.releases")}>
          {changelog.status.type === "loading" && changelog.releases.length === 0 && (
            <p className="play-empty">{t("changelog.loading")}</p>
          )}
          {changelog.status.type === "ready" && filtered.length === 0 && (
            <p className="play-empty">{t("changelog.noMatch")}</p>
          )}

          {groups.map(([year, releases]) => (
            <section key={year || "branches"} className="changelog-year">
              <h3 className="changelog-year-label">
                {year || t("changelog.branches")}
              </h3>
              {releases.map((release) => (
                <button
                  key={release.id}
                  type="button"
                  role="option"
                  aria-selected={release.id === changelog.selected}
                  className={`changelog-release${release.id === changelog.selected ? " active" : ""}`}
                  onClick={() => select(release.id)}
                >
                  <span className="changelog-release-id">{release.id}</span>
                  <span className="changelog-release-meta">
                    <span
                      className={`changelog-kind changelog-kind-${
                        release.kind === "Hotfix" ? "hotfix" : "patch"
                      }`}
                    >
                      {release.kind}
                    </span>
                    {release.date && <span className="changelog-date">{release.date}</span>}
                  </span>
                </button>
              ))}
            </section>
          ))}
        </div>
      </aside>

      <section className="changelog-note surface-panel">
        {selected && (
          <header className="changelog-note-head">
            <div>
              <h2>{entry?.title || selected.id}</h2>
              {selected.date && <p className="changelog-note-date">{selected.date}</p>}
            </div>
            <button
              type="button"
              className="changelog-external"
              onClick={() => void native.openUrl(selected.webUrl)}
            >
              <Icon name="external" size={13} /> {t("changelog.openOnSite")}
            </button>
          </header>
        )}

        <div className="changelog-note-body">
          {loadingEntry && !entry && <p className="play-empty">{t("changelog.loadingNote")}</p>}

          {changelog.entryStatus.type === "failed" && !entry && (
            <p className="play-empty">{changelog.entryStatus.payload.reason}</p>
          )}

          {!selected && changelog.status.type === "ready" && (
            <p className="play-empty">{t("changelog.pick")}</p>
          )}

          {entry?.blocks.map((block, index) => <Block key={index} block={block} />)}
        </div>
      </section>
    </div>
  );
}
