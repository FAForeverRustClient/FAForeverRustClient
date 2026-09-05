// "I want to find something specific."
//
// The hub's front page shows a handful of things chosen for the reader; this is
// the other half, and the two are deliberately different surfaces. Presenting
// the whole catalogue on the front page was one of the things wrong with every
// previous attempt at collecting FAF's training material: a list of hundreds of
// entries is not discovery, it is a filing cabinet.
//
// Filtering runs locally against the loaded catalogue (`shared/trainingRules`,
// a twin pinned by the conformance fixture) rather than as a command per
// keystroke.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { TrainingProfile, TrainingQuery, TrainingResource } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import { filterResources } from "../../shared/trainingRules";
import { EMPTY_TRAINING_QUERY, trainingQueryIsEmpty } from "../../shared/trainingQuery";
import { TrainingCard } from "./TrainingCard";
import { COMMON_MODES, KINDS, LEVELS, TOPICS, kindLabel, levelLabel, topicLabel } from "./trainingPresentation";

/**
 * One row of mutually exclusive filters.
 *
 * Chips rather than a dropdown, because the two answer different questions. A
 * dropdown asks "which one?" and hides the alternatives until you ask; a row of
 * chips answers "what is there?" before you touch it, which is what somebody
 * browsing a catalogue they have never seen actually wants to know. There are
 * at most ten options in any of these, so nothing is gained by hiding them.
 *
 * `null` is the whole row's off position, drawn as a chip too: an explicit
 * "Any" is easier to hit than clicking the selected one again, and it makes the
 * current state readable at a glance.
 */
function ChipRow<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: { value: T; label: string }[];
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
              className={active ? "training-filter-chip is-on" : "training-filter-chip"}
              aria-pressed={active}
              // Pressing the active chip clears it. A filter you cannot turn
              // off without hunting for a reset is a trap.
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
  const found = filterResources(resources, query, profile);

  const modes = [...new Set([...COMMON_MODES, ...resources.flatMap((entry) => entry.gameModes)])];

  return (
    <section className="training-library">
      <header className="training-section-head">
        <div>
          <h3>{t("training.library.title")}</h3>
          <p className="muted">{t("training.library.lead")}</p>
        </div>
        <span className="muted training-count">
          {t("training.library.count", { count: found.length, total: resources.length })}
        </span>
      </header>

      <div className="surface-panel training-filters">
        <div className="training-filter-line">
        <label className="training-search">
          <Icon name="search" size={15} />
          <input
            value={query.text}
            onChange={(event) => onQuery({ ...query, text: event.target.value })}
            placeholder={t("training.filter.searchPlaceholder")}
            aria-label={t("training.filter.search")}
          />
        </label>
        </div>

        <ChipRow
          label={t("training.filter.level")}
          value={query.level}
          options={LEVELS.map((level) => ({ value: level, label: t(levelLabel(level)) }))}
          onChange={(level) => onQuery({ ...query, level })}
        />
        <ChipRow
          label={t("training.filter.kind")}
          value={query.kind}
          options={KINDS.map((kind) => ({ value: kind, label: t(kindLabel(kind)) }))}
          onChange={(kind) => onQuery({ ...query, kind })}
        />
        <ChipRow
          label={t("training.filter.topic")}
          value={query.topic}
          options={TOPICS.map((topic) => ({ value: topic, label: t(topicLabel(topic)) }))}
          onChange={(topic) => onQuery({ ...query, topic })}
        />
        {/* The mode filter is a plain string in the query rather than an enum,
            so its off position is "" and not null. */}
        <ChipRow
          label={t("training.filter.mode")}
          value={query.gameMode === "" ? null : query.gameMode}
          options={modes.map((mode) => ({ value: mode, label: mode }))}
          onChange={(mode) => onQuery({ ...query, gameMode: mode ?? "" })}
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
                one by the global rating, so naming a single number here would
                describe the filter wrongly. */}
            <span title={t("training.filter.myRatingHint")}>{t("training.filter.myRating")}</span>
          </label>
        )}

        {!trainingQueryIsEmpty(query) && (
          <Button onClick={() => onQuery(EMPTY_TRAINING_QUERY)}>
            <Icon name="close" size={14} /> {t("training.filter.clear")}
          </Button>
        )}
        </div>
      </div>

      {found.length === 0 ? (
        <p className="surface training-state muted">
          <span>
            {resources.length === 0
              ? t("training.library.emptyCatalogue")
              : t("training.library.noMatches")}
          </span>
        </p>
      ) : (
        <div className="training-grid">
          {found.map((resource) => (
            <TrainingCard
              key={resource.id}
              resource={resource}
              onOpen={onOpen}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}
