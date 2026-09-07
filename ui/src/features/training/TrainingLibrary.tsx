// "I want to find something specific."
//
// The hub's front page shows a handful of things chosen for the reader; this is
// the other half, and the two are deliberately different surfaces. Presenting
// the whole catalogue on the front page was one of the things wrong with every
// previous attempt at collecting FAF's training material: a list of hundreds of
// entries is not discovery, it is a filing cabinet.
//
// Three levels of order, and the reader meets them in this sequence:
//
//   KIND         tabs across the top. What something *is* is the axis with the
//                most in it (thirty-five build orders, twenty-one videos,
//                twenty guides) and the one a reader arrives already knowing
//                the answer to, so it is navigation rather than a filter.
//   MODE         headings down the page. "A build order, for 1v1" is the whole
//                sentence a player says before opening this tab, and the two
//                axes together are it. Shelving by author, which this did
//                first, asked the reader to know the authors before the shelf
//                meant anything.
//   ENTRY        cards, in the order their author put them in.
//
// Across all three, one sort control the reader chooses (`libraryGroups`).
// The previous version ordered the shelf by an unstated relevance score, which
// left a reader with no way to disagree with it.
//
// Filtering runs locally against the loaded catalogue (`shared/trainingRules`,
// a twin pinned by the conformance fixture) rather than as a command per
// keystroke.

import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { SectionTabs, type SectionTab } from "../../design-system/SectionTabs";
import { Select } from "../../design-system/Select";
import type {
  TrainingKind,
  TrainingProfile,
  TrainingQuery,
  TrainingResource,
} from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { filterResources } from "../../shared/trainingRules";
import { EMPTY_TRAINING_QUERY, trainingQueryIsEmpty } from "../../shared/trainingQuery";
import { TrainingCard } from "./TrainingCard";
import {
  collectionsOf,
  LIBRARY_SORTS,
  sortLabel,
  type Collection,
  type LibrarySort,
} from "./libraryGroups";
import {
  COMMON_MODES,
  KINDS,
  LEVELS,
  TOPICS,
  kindPluralLabel,
  levelLabel,
  topicLabel,
} from "./trainingPresentation";


/**
 * One row of mutually exclusive filters.
 *
 * Chips rather than a dropdown, because the two answer different questions. A
 * dropdown asks "which one?" and hides the alternatives until you ask; a row of
 * chips answers "what is there?" before you touch it, which is what somebody
 * browsing a catalogue they have never seen actually wants to know. There are
 * at most ten options in any of these, so nothing is gained by hiding them.
 *
 * `null` is the whole row's off position, reached by pressing the chip that is
 * on: a filter you cannot turn off without hunting for a reset is a trap.
 *
 * An option that would return nothing is dimmed rather than removed. The row's
 * job is to say what the catalogue holds, and a set of chips that reshuffled
 * itself as the reader narrowed would answer that differently every time.
 */
function ChipRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: { value: T; label: string; empty?: boolean }[];
  onChange: (value: T | null) => void;
}) {
  return (
    <div className="training-chip-row" role="group" aria-label={label}>
      <span className="training-chip-row-label">{label}</span>
      <div className="training-chip-options">
        {options.map((option) => {
          const active = value === option.value;
          return (
            <button
              type="button"
              key={option.value}
              className={[
                "training-filter-chip",
                active ? "is-on" : "",
                option.empty && !active ? "is-empty" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              aria-pressed={active}
              onClick={() => onChange(active ? null : option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A shelf's preview length before the grid has been measured.
 *
 * A row's worth at the width the client is usually run at. Only ever seen for
 * the frame between mount and layout, and by the static render the design
 * preview uses.
 */
const SHELF_PREVIEW = 6;

/**
 * How many cards fit on one row, asked of the grid rather than assumed.
 *
 * The track count lives in CSS, as an `auto-fill` over a minimum card width,
 * and reading it back is what keeps it one number instead of two that have to
 * agree. A shelf clipped to a fixed count leaves an orphan card on a second row
 * at every width where the two disagree, which reads as a mistake rather than
 * as a preview.
 *
 * `auto-fill` lays out as many tracks as the width allows whether or not there
 * are cards for them, so the answer does not change when the shelf is clipped
 * to it. That is what stops this from oscillating.
 */
function useRowLength(ref: RefObject<HTMLDivElement | null>): number | null {
  const [columns, setColumns] = useState<number | null>(null);
  useLayoutEffect(() => {
    const grid = ref.current;
    if (!grid || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const tracks = getComputedStyle(grid).gridTemplateColumns;
      setColumns(tracks === "none" ? null : tracks.split(" ").length);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [ref]);
  return columns;
}

interface Props {
  resources: TrainingResource[];
  query: TrainingQuery;
  /**
   * The reader, for the "at my rating" switch. A profile rather than a number
   * because FAF keeps five ratings and which one applies depends on the entry.
   */
  profile: TrainingProfile;
  /** The overall rating, for the switch's own label. */
  myRating: number | null;
  onQuery: (query: TrainingQuery) => void;
  onOpen: (resource: TrainingResource) => void;
  onSelect: (resource: TrainingResource) => void;
}

export function TrainingLibrary({
  resources,
  query,
  profile,
  myRating,
  onQuery,
  onOpen,
  onSelect,
}: Props) {
  const { t } = useTranslation();
  // Two pieces of local state, and both are presentation the backend never acts
  // on: how the shelf is ordered, and whether the narrow filters are unfolded.
  // The query itself lives in the slice, because the hub's topic tiles set it
  // from another section and it has to survive that crossing.
  const [sort, setSort] = useState<LibrarySort>("forYou");
  const [refining, setRefining] = useState(false);

  const found = filterResources(resources, query, profile);
  // Counted with the kind cleared, so a tab says how many entries it *would*
  // show. A count that collapsed to zero on every tab but the open one would
  // be a fact about the filter rather than about the catalogue.
  const acrossKinds = filterResources(resources, { ...query, kind: null }, profile);

  // Shelved rather than listed. Recomputed per keystroke on purpose: narrowing
  // the filter changes which shelves survive it, and stale headings over a
  // filtered grid would be worse than none.
  const collections = collectionsOf(found, profile, sort);

  const modes = [...new Set([...COMMON_MODES, ...resources.flatMap((entry) => entry.gameModes)])];

  // Each visible facet, measured with itself cleared: a topic chip says what it
  // would find beside the *other* filters, which is the only reading of it a
  // reader can act on. Measured against the loaded catalogue, ninety rows and
  // fifteen options, so it costs nothing to redo per keystroke.
  const acrossTopics = filterResources(resources, { ...query, topic: null }, profile);
  const acrossModes = filterResources(resources, { ...query, gameMode: "" }, profile);

  const kindTabs: SectionTab<TrainingKind | "all">[] = [
    { id: "all", label: t("training.library.allKinds"), count: acrossKinds.length },
    ...KINDS.map((kind) => ({
      id: kind,
      label: t(kindPluralLabel(kind)),
      count: acrossKinds.filter((entry) => entry.kind === kind).length,
    })),
  ];

  /**
   * The narrow filters, as the reader would say them back.
   *
   * Folded away, they would be the one thing that can narrow a shelf without
   * saying so, which is the failure mode of every disclosure: a reader who
   * left "for my rating" on last week opens the library, sees a third of it,
   * and has nothing on screen explaining why. So each one that is on is drawn
   * as a chip that removes itself, whether the panel is open or shut.
   */
  const narrowed: { key: string; label: string; clear: () => void }[] = [];
  if (query.level !== null) {
    const level = query.level;
    narrowed.push({
      key: "level",
      label: t(levelLabel(level)),
      clear: () => onQuery({ ...query, level: null }),
    });
  }
  if (query.topic !== null) {
    const topic = query.topic;
    narrowed.push({
      key: "topic",
      label: t(topicLabel(topic)),
      clear: () => onQuery({ ...query, topic: null }),
    });
  }
  if (query.gameMode !== "") {
    narrowed.push({
      key: "mode",
      label: query.gameMode,
      clear: () => onQuery({ ...query, gameMode: "" }),
    });
  }
  if (query.map.trim() !== "") {
    narrowed.push({
      key: "map",
      label: query.map.trim(),
      clear: () => onQuery({ ...query, map: "" }),
    });
  }
  if (query.myRatingOnly) {
    narrowed.push({
      key: "rating",
      label: t("training.filter.myRating"),
      clear: () => onQuery({ ...query, myRatingOnly: false }),
    });
  }

  return (
    <section className="training-library">
      {/* The library's three controls ride the title line, which was otherwise
          a heading and a number: which words, which order, and the way in to
          the narrow filters. */}
      <header className="training-section-head">
        <div>
          <h3>{t("training.library.title")}</h3>
          <p className="muted">{t("training.library.lead")}</p>
        </div>
        <div className="training-toolbar-tools">
          <label className="training-search">
            <Icon name="search" size={15} />
            <input
              value={query.text}
              onChange={(event) => onQuery({ ...query, text: event.target.value })}
              placeholder={t("training.filter.searchPlaceholder")}
              aria-label={t("training.filter.search")}
            />
          </label>
          <Select
            className="training-sort"
            label={t("training.library.sort")}
            value={sort}
            options={LIBRARY_SORTS.map((option) => ({
              value: option,
              label: t(sortLabel(option)),
            }))}
            onChange={setSort}
          />
          <Button
            className={refining ? "is-on" : undefined}
            aria-expanded={refining}
            onClick={() => setRefining(!refining)}
          >
            <Icon name="filter" size={14} /> {t("training.filter.more")}
            {narrowed.length > 0 && (
              <span className="training-filter-count">{narrowed.length}</span>
            )}
          </Button>
        </div>
      </header>

      {/* Kind is navigation, not a filter: it is the axis with the most in it
          and the one a reader arrives having already decided. The tally sits
          at the far end of the same rule, beside the counts it is a total of. */}
      <div className="training-library-tabs">
        <SectionTabs
          active={query.kind ?? "all"}
          ariaLabel={t("training.filter.kind")}
          className="training-kind-tabs"
          items={kindTabs}
          onChange={(kind) => onQuery({ ...query, kind: kind === "all" ? null : kind })}
        />
        <span className="muted training-count">
          {t("training.library.count", { count: found.length, total: resources.length })}
        </span>
      </div>

      {/* The two axes with breadth stay on screen: ten topics and five modes
          are worth reading before they are used, which is the whole argument
          for chips over a dropdown. */}
      <div className="training-facets">
        <ChipRow
          label={t("training.filter.topic")}
          value={query.topic}
          options={TOPICS.map((topic) => ({
            value: topic,
            label: t(topicLabel(topic)),
            empty: !acrossTopics.some((entry) => entry.topics.includes(topic)),
          }))}
          onChange={(topic) => onQuery({ ...query, topic })}
        />
        {/* The mode filter is a plain string in the query rather than an enum,
            so its off position is "" and not null. */}
        <ChipRow
          label={t("training.filter.mode")}
          value={query.gameMode === "" ? null : query.gameMode}
          options={modes.map((mode) => ({
            value: mode,
            label: mode,
            empty: !acrossModes.some((entry) => entry.gameModes.includes(mode)),
          }))}
          onChange={(mode) => onQuery({ ...query, gameMode: mode ?? "" })}
        />
      </div>

      {/* Folded by default, and honestly so: six of ninety entries state a
          level at all, and a row of chips that answers "three" is furniture
          above everything a reader came for. */}
      {refining && (
        <div className="surface-panel training-filters">
          <ChipRow
            label={t("training.filter.level")}
            value={query.level}
            options={LEVELS.map((level) => ({ value: level, label: t(levelLabel(level)) }))}
            onChange={(level) => onQuery({ ...query, level })}
          />
          <div className="training-filter-line">
            <label className="training-map-filter">
              <span>{t("training.filter.map")}</span>
              <input
                value={query.map}
                onChange={(event) => onQuery({ ...query, map: event.target.value })}
                placeholder={t("training.filter.mapPlaceholder")}
              />
            </label>

            {/* Only offered when a rating is known: a switch that silently did
                nothing would be worse than an absent one. */}
            {myRating !== null && (
              <label className="training-toggle">
                <input
                  type="checkbox"
                  checked={query.myRatingOnly}
                  onChange={(event) => onQuery({ ...query, myRatingOnly: event.target.checked })}
                />
                {/* No number in the label. Which rating applies depends on the
                    entry: a 1v1 guide is judged by the 1v1 rating and a general
                    one by the global rating, so naming a single number here
                    would describe the filter wrongly. */}
                <span title={t("training.filter.myRatingHint")}>{t("training.filter.myRating")}</span>
              </label>
            )}
          </div>
        </div>
      )}

      {narrowed.length > 0 && (
        <div className="training-active-filters">
          <span className="training-chip-row-label">{t("training.filter.narrowedBy")}</span>
          {narrowed.map((filter) => (
            <button
              type="button"
              key={filter.key}
              className="training-active-chip"
              onClick={filter.clear}
            >
              {filter.label}
              <Icon name="close" size={11} />
            </button>
          ))}
          {!trainingQueryIsEmpty(query) && (
            <button
              type="button"
              className="training-clear-all"
              onClick={() => onQuery(EMPTY_TRAINING_QUERY)}
            >
              {t("training.filter.clear")}
            </button>
          )}
        </div>
      )}

      {found.length === 0 ? (
        <p className="surface training-state muted">
          <span>
            {resources.length === 0
              ? t("training.library.emptyCatalogue")
              : t("training.library.noMatches")}
          </span>
          {!trainingQueryIsEmpty(query) && (
            <Button onClick={() => onQuery(EMPTY_TRAINING_QUERY)}>
              <Icon name="close" size={14} /> {t("training.filter.clear")}
            </Button>
          )}
        </p>
      ) : (
        <div className="training-collections">
          {collections.map((collection) => (
            <CollectionShelf
              key={collection.key}
              collection={collection}
              // An untouched library is an overview and gives every shelf one
              // row; the moment the reader narrows it, it is a result and shows
              // all of it. Ninety cards under twelve headings is four screens
              // of scrolling before the second heading, which is the same flat
              // list the grouping exists to undo.
              clip={trainingQueryIsEmpty(query)}
              onOpen={onOpen}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One collection: a heading that stays put, and its cards.
 *
 * The heading is sticky because the page is the scroller and a reader three
 * screens into Sladow-Noob's twenty-one build orders has otherwise lost which
 * shelf they are standing at. It costs no chrome and nothing moves: the
 * heading is where it always was, it simply stops leaving.
 */
function CollectionShelf({
  collection,
  clip,
  onOpen,
  onSelect,
}: {
  collection: Collection;
  /** Whether to show one row and offer the rest, or lay the whole shelf out. */
  clip: boolean;
  onOpen: (resource: TrainingResource) => void;
  onSelect: (resource: TrainingResource) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const grid = useRef<HTMLDivElement>(null);
  const limit = useRowLength(grid) ?? SHELF_PREVIEW;
  const hidden = clip && !open ? Math.max(0, collection.entries.length - limit) : 0;
  const shown = hidden === 0 ? collection.entries : collection.entries.slice(0, limit);

  return (
    <section className="training-collection">
      <header className="training-collection-head">
        <div className="training-collection-name">
          {/* The mode as the catalogue writes it. Not translated: "1v1" and
              "4v4" are the same in every language the client speaks, and the
              bucket for entries naming none is the only heading here that is
              a sentence rather than a name. */}
          <h4>{collection.isRemainder ? t("training.library.noMode") : collection.key}</h4>
        </div>
        <span className="training-collection-count">
          {hidden > 0 || open ? (
            // The count is the control. A shelf saying "21" and a button saying
            // "show all" are the same sentence twice, and the number is the
            // part a reader was already looking at.
            <button type="button" className="training-shelf-more" onClick={() => setOpen(!open)}>
              {open
                ? t("training.library.showFewer")
                : t("training.library.showAll", { count: collection.entries.length })}
            </button>
          ) : (
            collection.entries.length
          )}
        </span>
      </header>
      <div className="training-grid" ref={grid}>
        {shown.map((resource) => (
          <TrainingCard key={resource.id} resource={resource} onOpen={onOpen} onSelect={onSelect} />
        ))}
      </div>
    </section>
  );
}
