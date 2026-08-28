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

import { useEffect, useState } from "react";
import type { League, ReplayQuery, ReplaySortField } from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { MultiSelect, type MultiSelectOption } from "../../design-system/MultiSelect";
import { RangeSlider } from "../../design-system/RangeSlider";
import {
  advancedReplayFilterCount,
  ALL_TIME_AFTER,
  EMPTY_REPLAY_QUERY,
  isoDaysAgo,
} from "../../shared/replayQuery";
import { AdvancedReplayFilters } from "./AdvancedReplayFilters";
import "../../design-system/search-panel.css";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

const MIN_RATING = -1000;
const MAX_RATING = 4000;

const SORT_LABELS: Record<ReplaySortField, MessageKey> = {
  startTime: "replays.search.sort.datePlayed",
  endTime: "replays.search.sort.dateFinished",
  duration: "replays.search.sort.duration",
  reviewScore: "replays.search.sort.reviewScore",
  title: "replays.search.sort.gameTitle",
  id: "replays.search.sort.replayId",
  victoryCondition: "replays.search.sort.victoryCondition",
};

/** The Java client's show-room categories, as one-click presets. */
type Preset = "newest" | "highestRated" | "own";

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

export function VaultSearch({ featuredMods, leagues, self, initialQuery, onSearch }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ReplayQuery>(initialQuery);
  const [advanced, setAdvanced] = useState(false);
  // Reflects the date bound already in the query, so the button matches what is
  // actually being searched rather than a separate opinion about it.
  const [recentOnly, setRecentOnly] = useState(
    () => initialQuery.after !== ALL_TIME_AFTER,
  );

  useEffect(() => {
    setForm(initialQuery);
    setRecentOnly(initialQuery.after !== ALL_TIME_AFTER);
  }, [initialQuery]);

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
          ? {
              ...base,
              sortBy: "reviewScore",
              sortDescending: true,
              minReviewScore: 4,
              // An explicit bound, because `minReviewScore` counts as a
              // narrowing filter and the backend then silently applies its
              // 3-month cost floor (`ReplayQuery::fallback_months`). Almost
              // nobody reviews a replay, so "best reviewed" was really "best
              // reviewed since May" and returned a handful of results. Three
              // years still bounds the query, and being explicit means the
              // date shows up in the form instead of being invisible.
              after: isoDaysAgo(365 * 3),
            }
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
          <span className="vault-field-label search-panel-label">{t("replays.search.player")}</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            value={form.player}
            placeholder={t("replays.search.anyPlayer")}
            title={t("replays.search.playerTooltip")}
            onChange={(e) => set("player", e.target.value)}
          />
        </label>

        <label className="vault-field vault-field-grow search-panel-field search-panel-field-grow">
          <span className="vault-field-label search-panel-label">{t("replays.search.map")}</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            value={form.map}
            placeholder={t("replays.search.anyMap")}
            onChange={(e) => set("map", e.target.value)}
          />
        </label>

        <label className="vault-field vault-search-replay-id search-panel-field">
          <span className="vault-field-label search-panel-label">{t("replays.search.replayId")}</span>
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
            label={t("replays.search.leaderboard")}
            options={leagueOptions}
            selected={form.leaderboards}
            onChange={(v) => set("leaderboards", v)}
          />
        </div>

        <div className="vault-field vault-search-mod">
          <MultiSelect
            label={t("replays.search.mod")}
            options={modOptions}
            selected={form.featuredMods}
            onChange={(v) => set("featuredMods", v)}
          />
        </div>

        <div className="vault-search-rating">
          <RangeSlider
            label={t("replays.search.rating")}
            min={MIN_RATING}
            max={MAX_RATING}
            step={50}
            low={form.minRating}
            high={form.maxRating}
            onChange={(lo, hi) => setRange("minRating", "maxRating", lo, hi)}
          />
        </div>

        <label className="vault-field search-panel-field">
          <span className="vault-field-label search-panel-label">{t("replays.search.sortBy")}</span>
          <select
            className="vault-input search-panel-control"
            value={form.sortBy}
            onChange={(e) => set("sortBy", e.target.value as ReplaySortField)}
          >
            {(Object.keys(SORT_LABELS) as ReplaySortField[]).map((field) => (
              <option key={field} value={field}>
                {t(SORT_LABELS[field])}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="vault-input search-panel-control vault-sort-order"
          aria-label={t(form.sortDescending ? "replays.search.descendingAria" : "replays.search.ascendingAria")}
          title={t(form.sortDescending ? "replays.search.descending" : "replays.search.ascending")}
          onClick={toggleSortDirection}
        >
          {form.sortDescending ? "↓" : "↑"}
        </button>

        <Button type="submit" variant="primary" className="vault-search-submit search-panel-submit">
          <Icon name="search" size={15} /> {t("replays.search.submit")}
        </Button>
      </div>

      <div className="vault-search-presets search-panel-secondary">
        <Button type="button" onClick={() => applyPreset("newest")}>
          {t("replays.search.preset.newest")}
        </Button>
        <Button type="button" onClick={() => applyPreset("highestRated")}>
          {t("replays.search.preset.bestReviewed")}
        </Button>
        {/* A toggle, not a preset. The backend silently floors any narrowing
            search to the last few months, which is right for speed and wrong
            when it is invisible; this is that floor made into a control the user
            can see and switch off. On by default, because the unbounded query is
            the slow one. */}
        <Button
          type="button"
          className={recentOnly ? "active" : ""}
          aria-pressed={recentOnly}
          title={t("replays.search.recentOnlyHint")}
          onClick={() => {
            const next = !recentOnly;
            setRecentOnly(next);
            const query = {
              ...form,
              after: next ? isoDaysAgo(365) : ALL_TIME_AFTER,
              page: 1,
            };
            setForm(query);
            onSearch(query);
          }}
        >
          {t("replays.search.recentOnly")}
        </Button>
        <Button type="button" disabled={!self} onClick={() => applyPreset("own")}>
          {t("replays.search.preset.myReplays")}
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
            ? t("replays.search.fewerFilters")
            : hiddenFilterCount > 0
              ? t("replays.search.moreFiltersCount", { count: hiddenFilterCount })
              : t("replays.search.moreFilters")}
        </button>
        <Button type="button" onClick={reset}>
          {t("replays.search.clear")}
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
