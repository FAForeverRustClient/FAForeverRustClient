// Replay vault search form.
//
// The union of both reference clients' vault searches, which overlap but don't
// match:
//
//   Python (`_replayswidget.prepareFilters`)  player (+exact toggle), map,
//     leaderboard, featured mod, min rating, date range, result count,
//     "hide unranked"
//   Java (`OnlineReplayVaultController`)      the above plus map author, game
//     title, replay id, host, faction, victory condition, map slots/size,
//     ranked-map-only, rating/duration/review-score *range sliders*,
//     multi-select mod and leaderboard filters, a sortable-property picker,
//     and the Own/Newest/Highest-rated show-room presets
//
// The ranges are sliders rather than number boxes because that is what the
// Java client uses (ControlsFX `RangeSlider`) and because the useful bounds
// aren't obvious from an empty field; a slider shows you that ratings run to
// 4000 and that games are usually under an hour.
//
// The form is local state; only pressing Search (or Enter, paging, or the sort
// direction toggle) sends a query to the backend. A text box that dispatched
// IPC on every keystroke would hammer the API, and the reference clients are
// explicit that unbounded vault queries are expensive. What the backend
// *executed* lives in `state.replays.vaultQuery`, so the results and their
// description can't drift.

import { useState } from "react";
import type { League, ReplayQuery, ReplaySortField } from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { MultiSelect, type MultiSelectOption } from "../../design-system/MultiSelect";
import { RangeSlider } from "../../design-system/RangeSlider";
import { advancedReplayFilterCount, EMPTY_REPLAY_QUERY } from "../../shared/replayQuery";
import { AdvancedReplayFilters } from "./AdvancedReplayFilters";
import "../../design-system/search-panel.css";

const MIN_RATING = -1000;
const MAX_RATING = 4000;

const SORT_LABELS: Record<ReplaySortField, string> = {
  startTime: "Date played",
  endTime: "Date finished",
  duration: "Duration",
  reviewScore: "Review score",
  title: "Game title",
  id: "Replay ID",
  victoryCondition: "Victory condition",
};

/** The Java client's show-room categories, as one-click presets. */
type Preset = "newest" | "highestRated" | "own" | "lastYear";

interface Props {
  /** Featured mod technical names from the API. */
  featuredMods: string[];
  leagues: League[];
  /** Logged-in player, for the "My replays" preset. */
  self: string;
  /** Executed query (or the first query about to execute) when this form mounts. */
  initialQuery: ReplayQuery;
  onSearch: (query: ReplayQuery) => void;
}

const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

export function VaultSearch({ featuredMods, leagues, self, initialQuery, onSearch }: Props) {
  const [form, setForm] = useState<ReplayQuery>(initialQuery);
  const [advanced, setAdvanced] = useState(false);

  // `page` is not part of the form: a new search always starts at page 1, and
  // paging is driven from the executed query instead.
  const set = <K extends keyof ReplayQuery>(key: K, value: ReplayQuery[K]) =>
    setForm((f) => ({ ...f, [key]: value, page: 1 }));

  const setRange = (
    lowKey: keyof ReplayQuery,
    highKey: keyof ReplayQuery,
    low: number | null,
    high: number | null,
  ) => setForm((f) => ({ ...f, [lowKey]: low, [highKey]: high, page: 1 }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch({ ...form, page: 1 });
  };

  const toggleSortDirection = () => {
    const query = { ...form, sortDescending: !form.sortDescending, page: 1 };
    setForm(query);
    onSearch(query);
  };

  const reset = () => {
    setForm(EMPTY_REPLAY_QUERY);
    onSearch(EMPTY_REPLAY_QUERY);
  };

  const applyPreset = (preset: Preset) => {
    const base: ReplayQuery = { ...EMPTY_REPLAY_QUERY };
    const query: ReplayQuery =
      preset === "own"
        ? { ...base, player: self, exactPlayer: true }
        : preset === "highestRated"
          ? { ...base, sortBy: "reviewScore", sortDescending: true, minReviewScore: 4 }
          : preset === "lastYear"
            ? { ...base, after: isoDaysAgo(365) }
            : base;
    setForm(query);
    onSearch(query);
  };

  const modOptions: MultiSelectOption[] = featuredMods.map((m) => ({ value: m, label: m }));
  const leagueOptions: MultiSelectOption[] = leagues.map((l) => ({
    value: l.technicalName,
    label: l.technicalName,
  }));
  const hiddenFilterCount = advancedReplayFilterCount(form);

  return (
    <form className="vault-search online-vault-search search-panel surface-panel" onSubmit={submit}>
      <div className="vault-search-primary search-panel-primary">
        <label className="vault-field vault-field-grow search-panel-field search-panel-field-grow">
          <span className="vault-field-label search-panel-label">Player</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            value={form.player}
            placeholder="Any player"
            onChange={(e) => set("player", e.target.value)}
          />
        </label>

        <label className="vault-field vault-field-grow search-panel-field search-panel-field-grow">
          <span className="vault-field-label search-panel-label">Map</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            value={form.map}
            placeholder="Any map"
            onChange={(e) => set("map", e.target.value)}
          />
        </label>

        <label className="vault-field vault-search-replay-id search-panel-field">
          <span className="vault-field-label search-panel-label">Replay ID</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            inputMode="numeric"
            value={form.replayId}
            onChange={(e) => set("replayId", e.target.value)}
          />
        </label>

        <div className="vault-field vault-search-leaderboard">
          <MultiSelect
            label="Leaderboard"
            options={leagueOptions}
            selected={form.leaderboards}
            onChange={(v) => set("leaderboards", v)}
          />
        </div>

        <div className="vault-field vault-search-mod">
          <MultiSelect
            label="Mod"
            options={modOptions}
            selected={form.featuredMods}
            onChange={(v) => set("featuredMods", v)}
          />
        </div>

        <div className="vault-search-rating">
          <RangeSlider
            label="Rating"
            min={MIN_RATING}
            max={MAX_RATING}
            step={50}
            low={form.minRating}
            high={form.maxRating}
            onChange={(lo, hi) => setRange("minRating", "maxRating", lo, hi)}
          />
        </div>

        <label className="vault-field search-panel-field">
          <span className="vault-field-label search-panel-label">Sort by</span>
          <select
            className="vault-input search-panel-control"
            value={form.sortBy}
            onChange={(e) => set("sortBy", e.target.value as ReplaySortField)}
          >
            {(Object.keys(SORT_LABELS) as ReplaySortField[]).map((field) => (
              <option key={field} value={field}>
                {SORT_LABELS[field]}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="vault-input search-panel-control vault-sort-order"
          aria-label={form.sortDescending ? "Descending; click for ascending" : "Ascending; click for descending"}
          title={form.sortDescending ? "Descending" : "Ascending"}
          onClick={toggleSortDirection}
        >
          {form.sortDescending ? "↓" : "↑"}
        </button>

        <Button type="submit" variant="primary" className="vault-search-submit search-panel-submit">
          <Icon name="search" size={15} /> Search
        </Button>
      </div>

      <div className="vault-search-presets search-panel-secondary">
        <Button type="button" onClick={() => applyPreset("newest")}>
          Newest
        </Button>
        <Button type="button" onClick={() => applyPreset("highestRated")}>
          Best reviewed
        </Button>
        <Button type="button" onClick={() => applyPreset("lastYear")}>
          Last year
        </Button>
        <Button type="button" disabled={!self} onClick={() => applyPreset("own")}>
          My replays
        </Button>
        <span className="spacer" />
        <button
          type="button"
          className="vault-toggle-advanced search-panel-toggle"
          aria-expanded={advanced}
          onClick={() => setAdvanced((a) => !a)}
        >
          <Icon name="filter" size={14} />
          {advanced
            ? "Fewer filters"
            : `More filters${hiddenFilterCount > 0 ? ` (${hiddenFilterCount})` : ""}`}
        </button>
        <Button type="button" onClick={reset}>
          Clear
        </Button>
      </div>

      {advanced && (
        <AdvancedReplayFilters
          form={form}
          set={set}
          setRange={setRange}
        />
      )}
    </form>
  );
}
