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
// Filtering runs locally against the loaded catalogue (`shared/rules/trainingRules`,
// a twin pinned by the conformance fixture) rather than as a command per
// keystroke, and the search box is controlled locally for the same reason
// (`useQueryDraft`).

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { SectionTabs, sectionPanelProps, type SectionTab } from "../../design-system/SectionTabs";
import { Select } from "../../design-system/Select";
import type {
  TrainingKind,
  TrainingProfile,
  TrainingQuery,
  TrainingResource,
} from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import {
  asciiLower,
  eqIgnoreAsciiCase,
  filterResources,
  rustTrim,
} from "../../shared/rules/trainingRules";
import { EMPTY_TRAINING_QUERY, trainingQueryIsEmpty } from "../../shared/trainingQuery";
import { ChannelsCard, CreatorTile, TrainingCard } from "./TrainingCard";
import {
  channelsForMode,
  collectionsOf,
  CREATOR_KINDS,
  LIBRARY_SORTS,
  isQueueMode,
  modeOptions,
  sortLabel,
  type Collection,
} from "./libraryGroups";
import { foldSeries, seriesIndex, type Series } from "./trainingSeries";
import {
  KINDS,
  LEVELS,
  TOPICS,
  kindPluralLabel,
  levelLabel,
  topicLabel,
} from "./trainingPresentation";
import { shelfKey, useTrainingView } from "./trainingViewState";


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
 * "Would return nothing" is the caller's to decide, with the filter itself.
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

/** How long the search and map boxes wait for typing to pause before the query is sent. */
const DRAFT_DELAY_MS = 200;

/** The two typed fields of the query, which the boxes own while typing. */
interface Draft {
  text: string;
  map: string;
}

const draftOf = (query: TrainingQuery): Draft => ({ text: query.text, map: query.map });
const sameDraft = (a: Draft, b: Draft) => a.text === b.text && a.map === b.map;

/**
 * The typed fields of the query, owned by the inputs while the reader types.
 *
 * The query lives in the slice, and the boxes used to be fed straight from it:
 * every keystroke went out as `setQuery` and the character only appeared once
 * the echo came back. That is the round trip `docs/training-features.md` warns
 * about, and it showed: the cursor jumped to the end and fast typing dropped
 * characters. So the boxes are controlled by local state, the filter runs on
 * that local text at once, and the slice hears about it once typing pauses.
 *
 * The slice's copy is still adopted when it changes for a reason of its own
 * (the hub's topic tiles reset it), and never when it is merely the echo of
 * something sent from here: those are remembered until they come back, so an
 * echo that arrives after the reader has typed on is recognised and dropped.
 *
 * Every other change to the query goes through `send` as well, carrying the
 * current text, so a chip pressed mid-word cannot send the slice's older text
 * back and have it overwrite the box.
 */
function useQueryDraft(query: TrainingQuery, onQuery: (query: TrainingQuery) => void) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(query));
  const draftRef = useRef<Draft>(draftOf(query));
  const inFlight = useRef<Draft[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ query, onQuery });
  useLayoutEffect(() => {
    latest.current = { query, onQuery };
  });

  const deliver = useCallback((next: TrainingQuery) => {
    const snapshot = draftOf(next);
    if (!sameDraft(snapshot, draftOf(latest.current.query))) inFlight.current.push(snapshot);
    latest.current.onQuery(next);
  }, []);

  const cancelTimer = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  /** Send a whole query now, typed fields included. */
  const send = (next: TrainingQuery) => {
    cancelTimer();
    draftRef.current = draftOf(next);
    setDraft(draftRef.current);
    deliver(next);
  };

  /** One keystroke in a box: shown and filtered at once, sent once typing pauses. */
  const edit = (field: keyof Draft, value: string) => {
    draftRef.current = { ...draftRef.current, [field]: value };
    setDraft(draftRef.current);
    cancelTimer();
    timer.current = setTimeout(() => {
      timer.current = null;
      deliver({ ...latest.current.query, ...draftRef.current });
    }, DRAFT_DELAY_MS);
  };

  const incomingText = query.text;
  const incomingMap = query.map;
  useEffect(() => {
    const incoming = { text: incomingText, map: incomingMap };
    const echo = inFlight.current.findIndex((sent) => sameDraft(sent, incoming));
    if (echo >= 0) {
      inFlight.current.splice(0, echo + 1);
      return;
    }
    inFlight.current = [];
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!sameDraft(draftRef.current, incoming)) {
      draftRef.current = incoming;
      setDraft(incoming);
    }
  }, [incomingText, incomingMap]);

  // Opening a guide unmounts the library. Typing that has not been sent yet
  // goes out then rather than being lost with the component.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
        deliver({ ...latest.current.query, ...draftRef.current });
      }
    },
    [deliver],
  );

  return { draft, effective: { ...query, ...draft }, send, edit };
}

/** The library's own kind tabs, tied to the shelves below them. */
const KIND_TABS_ID = "training-kind";

interface Props {
  resources: TrainingResource[];
  /** True until the catalogue has arrived, so an empty list is not mistaken for an empty catalogue. */
  loading: boolean;
  /** Ask for the catalogue again, from the empty state. */
  onReload: () => void;
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
  loading,
  onReload,
  query,
  profile,
  myRating,
  onQuery,
  onOpen,
  onSelect,
}: Props) {
  const { t } = useTranslation();
  // How the shelf is ordered and whether the narrow filters are unfolded are
  // presentation the backend never acts on, but they live outside this
  // component: opening a guide unmounts it, and back from the guide used to
  // reset both. The query itself lives in the slice, because the hub's topic
  // tiles set it from another section and it has to survive that crossing.
  const sort = useTrainingView((view) => view.sort);
  // The chapter whose channels are open as a grid, if one is.
  const [channelsOf, setChannelsOf] = useState<string | null>(null);
  const setSort = useTrainingView((view) => view.setSort);
  const refining = useTrainingView((view) => view.refining);
  const setRefining = useTrainingView((view) => view.setRefining);
  const { draft, effective, send, edit } = useQueryDraft(query, onQuery);

  const found = filterResources(resources, effective, profile);
  // Kind is navigation rather than a filter (see the tabs below), so it is
  // neither something "clear" removes nor a reason to stop previewing shelves.
  const narrowedBeyondKind = !trainingQueryIsEmpty({ ...effective, kind: null });
  // Counted with the kind cleared, so a tab says how many entries it *would*
  // show. A count that collapsed to zero on every tab but the open one would
  // be a fact about the filter rather than about the catalogue.
  const acrossKinds = filterResources(resources, { ...effective, kind: null }, profile);

  // The whole library is shelved by mode and by kind at once ("1v1 · Build
  // orders"); under a kind tab the kind is already chosen and the mode is the
  // shelf. Channels and community pages are not material and are not shelved
  // with it: they are a row of creators of their own, under the shelves.
  const wholeLibrary = effective.kind === null;
  const isCreator = (entry: TrainingResource) => CREATOR_KINDS.includes(entry.kind);
  const creators = wholeLibrary || effective.kind === "community" ? found.filter(isCreator) : [];
  const material = found.filter((entry) => !isCreator(entry));

  // An untouched library is an overview: a series is one card there, and its
  // episodes or parts are listed where it is opened. The moment the reader
  // narrows the library it is a result, and every match stands on its own,
  // or a search for episode seven would answer with episode one's card.
  const series = useMemo(() => seriesIndex(resources), [resources]);
  const fold = !narrowedBeyondKind;

  // Shelved rather than listed. Recomputed per keystroke on purpose: narrowing
  // the filter changes which shelves survive it, and stale headings over a
  // filtered grid would be worse than none.
  const collections = collectionsOf(material, profile, sort, wholeLibrary).map((collection) =>
    fold ? { ...collection, entries: foldSeries(collection.entries, series) } : collection,
  );

  const modes = modeOptions(resources);
  // The matchmaker's queues on one row, the custom-game formats the catalogue
  // names (Seton's Clutch) on their own: one is a queue a player joins, the
  // other a map a community plays its own way, and "4v4" answers neither.
  const queueModes = modes.filter(isQueueMode);
  const customGames = modes.filter((mode) => !isQueueMode(mode));
  // The chip that is on, in the row's own spelling, however the query spells it.
  const activeMode =
    effective.gameMode === ""
      ? null
      : (modes.find((mode) => eqIgnoreAsciiCase(mode, rustTrim(effective.gameMode))) ??
        effective.gameMode);

  // A chip is dimmed when pressing it would show nothing, asked of the filter
  // itself with that chip pressed and every other filter as it is. Any other
  // test drifts from what the press actually does: the previous one compared
  // modes exactly, so a dimmed "custom" chip still found every entry tagged
  // "global", and every entry naming no mode at all. Ninety rows and fifteen
  // options, so it costs nothing to redo per keystroke.
  const wouldFind = (narrowed: TrainingQuery) =>
    filterResources(resources, narrowed, profile).length > 0;

  const clearFilters = () => send({ ...EMPTY_TRAINING_QUERY, kind: effective.kind });

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
  if (effective.level !== null) {
    const level = effective.level;
    narrowed.push({
      key: "level",
      label: t(levelLabel(level)),
      clear: () => send({ ...effective, level: null }),
    });
  }
  if (effective.topic !== null) {
    const topic = effective.topic;
    narrowed.push({
      key: "topic",
      label: t(topicLabel(topic)),
      clear: () => send({ ...effective, topic: null }),
    });
  }
  if (effective.gameMode !== "") {
    narrowed.push({
      key: "mode",
      label: effective.gameMode,
      clear: () => send({ ...effective, gameMode: "" }),
    });
  }
  if (effective.map.trim() !== "") {
    narrowed.push({
      key: "map",
      label: effective.map.trim(),
      clear: () => send({ ...effective, map: "" }),
    });
  }
  if (effective.myRatingOnly) {
    narrowed.push({
      key: "rating",
      label: t("training.filter.myRating"),
      clear: () => send({ ...effective, myRatingOnly: false }),
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
        </div>
        <div className="training-toolbar-tools">
          <label className="training-search">
            <Icon name="search" size={15} />
            <input
              value={draft.text}
              onChange={(event) => edit("text", event.target.value)}
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
          active={effective.kind ?? "all"}
          ariaLabel={t("training.filter.kind")}
          className="training-kind-tabs"
          idPrefix={KIND_TABS_ID}
          items={kindTabs}
          onChange={(kind) => send({ ...effective, kind: kind === "all" ? null : kind })}
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
          value={effective.topic}
          options={TOPICS.map((topic) => ({
            value: topic,
            label: t(topicLabel(topic)),
            empty: !wouldFind({ ...effective, topic }),
          }))}
          onChange={(topic) => send({ ...effective, topic })}
        />
        {/* The mode filter is a plain string in the query rather than an enum,
            so its off position is "" and not null. */}
        <ChipRow
          label={t("training.filter.mode")}
          value={activeMode}
          options={queueModes.map((mode) => ({
            value: mode,
            label: mode,
            empty: !wouldFind({ ...effective, gameMode: mode }),
          }))}
          onChange={(mode) => send({ ...effective, gameMode: mode ?? "" })}
        />
        {/* The same filter as the row above, so pressing one here lets go of
            a queue there: an entry is for one or the other, never both. */}
        {customGames.length > 0 && (
          <ChipRow
            label={t("training.filter.customGames")}
            value={activeMode}
            options={customGames.map((mode) => ({
              value: mode,
              label: mode,
              empty: !wouldFind({ ...effective, gameMode: mode }),
            }))}
            onChange={(mode) => send({ ...effective, gameMode: mode ?? "" })}
          />
        )}
      </div>

      {/* Folded by default, and honestly so: six of ninety entries state a
          level at all, and a row of chips that answers "three" is furniture
          above everything a reader came for. */}
      {refining && (
        <div className="surface-panel training-filters">
          <ChipRow
            label={t("training.filter.level")}
            value={effective.level}
            options={LEVELS.map((level) => ({ value: level, label: t(levelLabel(level)) }))}
            onChange={(level) => send({ ...effective, level })}
          />
          <div className="training-filter-line">
            <label className="training-map-filter">
              <span>{t("training.filter.map")}</span>
              <input
                value={draft.map}
                onChange={(event) => edit("map", event.target.value)}
                placeholder={t("training.filter.mapPlaceholder")}
              />
            </label>

            {/* Only offered when a rating is known: a switch that silently did
                nothing would be worse than an absent one. */}
            {myRating !== null && (
              <label className="training-toggle">
                <input
                  type="checkbox"
                  checked={effective.myRatingOnly}
                  onChange={(event) => send({ ...effective, myRatingOnly: event.target.checked })}
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
          {narrowedBeyondKind && (
            <button type="button" className="training-clear-all" onClick={clearFilters}>
              {t("training.filter.clear")}
            </button>
          )}
        </div>
      )}

      <div {...sectionPanelProps(KIND_TABS_ID, effective.kind ?? "all")}>
        {found.length === 0 ? (
          <p className="surface training-state muted" aria-live="polite">
            <span>
              {resources.length > 0
                ? t("training.library.noMatches")
                : loading
                  ? t("training.loading")
                  : t("training.library.emptyCatalogue")}
            </span>
            {resources.length > 0 && narrowedBeyondKind && (
              <Button onClick={clearFilters}>
                <Icon name="close" size={14} /> {t("training.filter.clear")}
              </Button>
            )}
            {resources.length === 0 && !loading && (
              <Button onClick={onReload}>
                <Icon name="refresh" size={15} /> {t("training.tryAgain")}
              </Button>
            )}
          </p>
        ) : (
          <div className="training-collections">
            {collections.map((collection, index) => {
              // The last shelf of a mode is where its chapter ends, and where
              // the reader is pointed at the channels that hold more of it.
              // Only in the overview: a filtered result is an answer, and a
              // card of channels in it would be an answer to something else.
              const next = collections[index + 1];
              const endsChapter =
                !collection.isRemainder &&
                (next === undefined || asciiLower(next.key) !== asciiLower(collection.key));
              const more =
                endsChapter && !narrowedBeyondKind ? channelsForMode(resources, collection.key) : [];
              return (
                <CollectionShelf
                  key={`${collection.key}|${collection.kind ?? ""}`}
                  collection={collection}
                  series={fold ? series : null}
                  shelf={shelfKey(effective.kind, `${collection.key}|${collection.kind ?? ""}`)}
                  // An untouched library is an overview and gives every shelf one
                  // row; the moment the reader narrows it, it is a result and
                  // shows all of it. Ninety cards under twelve headings is four
                  // screens of scrolling before the second heading, which is the
                  // same flat list the grouping exists to undo. A kind tab is not
                  // narrowing: it is where the reader is standing, and it used to
                  // unfold every shelf under it.
                  clip={!narrowedBeyondKind}
                  onOpen={onOpen}
                  onSelect={onSelect}
                  last={
                    more.length > 0 ? (
                      <ChannelsCard
                        mode={collection.key}
                        channels={more}
                        onOpen={() => setChannelsOf(collection.key)}
                      />
                    ) : null
                  }
                />
              );
            })}
            {creators.length > 0 && (
              <section className="training-collection training-creators">
                <header className="training-collection-head">
                  <div className="training-collection-name">
                    <h4>{t("training.library.creators")}</h4>
                  </div>
                  <span className="training-collection-count">{creators.length}</span>
                </header>
                <div className="training-creator-grid">
                  {creators.map((creator) => (
                    <CreatorTile key={creator.id} resource={creator} onSelect={onSelect} />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>

      {channelsOf !== null && (
        <ChannelsDialog
          mode={channelsOf}
          channels={channelsForMode(resources, channelsOf)}
          onOpen={onOpen}
          onClose={() => setChannelsOf(null)}
        />
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
  series,
  shelf,
  clip,
  onOpen,
  onSelect,
  last = null,
}: {
  collection: Collection;
  /** The catalogue's series, when they are folded into one card each. */
  series: Map<string, Series> | null;
  /** Which shelf this is across visits, for remembering that it was opened. */
  shelf: string;
  /** Whether to show one row and offer the rest, or lay the whole shelf out. */
  clip: boolean;
  onOpen: (resource: TrainingResource) => void;
  onSelect: (resource: TrainingResource) => void;
  /**
   * A card that closes the shelf, after its entries: the chapter's channels.
   * It keeps its place in the first row when the shelf is clipped, so the
   * entries give way to it rather than it to them.
   */
  last?: ReactNode;
}) {
  const { t } = useTranslation();
  // Remembered outside the component, so a shelf opened before reading one of
  // its guides is still open on the way back.
  const open = useTrainingView((view) => view.openShelves.includes(shelf));
  const toggleShelf = useTrainingView((view) => view.toggleShelf);
  const grid = useRef<HTMLDivElement>(null);
  const row = useRowLength(grid) ?? SHELF_PREVIEW;
  const limit = last ? Math.max(1, row - 1) : row;
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
          <h4>
            {collection.kind === null
              ? collection.isRemainder
                ? t("training.library.noMode")
                : collection.key
              : collection.isRemainder
                ? t(kindPluralLabel(collection.kind))
                : `${collection.key} \u00b7 ${t(kindPluralLabel(collection.kind))}`}
          </h4>
        </div>
        <span className="training-collection-count">
          {clip && (hidden > 0 || open) ? (
            // The count is the control. A shelf saying "21" and a button saying
            // "show all" are the same sentence twice, and the number is the
            // part a reader was already looking at.
            <button type="button" className="training-shelf-more" onClick={() => toggleShelf(shelf)}>
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
          <TrainingCard
            key={resource.id}
            resource={resource}
            series={series?.get(resource.id)}
            onOpen={onOpen}
            onSelect={onSelect}
          />
        ))}
        {last}
      </div>
    </section>
  );
}

/**
 * The channels behind a chapter's last card, as a grid of faces: each opens
 * its channel. The same tile the creators row draws, so a channel looks like
 * itself wherever it appears.
 */
function ChannelsDialog({
  mode,
  channels,
  onOpen,
  onClose,
}: {
  mode: string;
  channels: TrainingResource[];
  onOpen: (resource: TrainingResource) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal
      onClose={onClose}
      ariaLabel={t("training.library.channels.dialogTitle", { mode })}
      className="training-dialog training-channels-dialog"
    >
      <div className="training-channels-dialog-body">
        <header>
          <h4>{t("training.library.channels.dialogTitle", { mode })}</h4>
          <p className="muted">{t("training.library.channels.dialogLead", { mode })}</p>
        </header>
        <div className="training-creator-grid">
          {channels.map((channel) => (
            <CreatorTile key={channel.id} resource={channel} onSelect={onOpen} />
          ))}
        </div>
      </div>
    </Modal>
  );
}
