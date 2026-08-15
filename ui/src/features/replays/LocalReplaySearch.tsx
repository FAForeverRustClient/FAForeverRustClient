import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { RangeSlider } from "../../design-system/RangeSlider";
import {
  EMPTY_LOCAL_REPLAY_QUERY,
  localReplayAdvancedFilterCount,
  type LocalReplayQuery,
  type LocalReplaySortField,
} from "./localReplayQuery";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

const SORT_LABELS: Record<LocalReplaySortField, MessageKey> = {
  date: "replays.search.sort.datePlayed",
  title: "replays.search.sort.gameTitle",
  map: "replays.search.sort.mapName",
  players: "replays.search.sort.playerCount",
  size: "replays.search.sort.fileSize",
};

const STATUS_OPTIONS: Array<{ value: LocalReplayQuery["status"]; label: MessageKey }> = [
  { value: "all", label: "replays.search.status.all" },
  { value: "complete", label: "replays.search.status.complete" },
  { value: "incomplete", label: "replays.search.status.incomplete" },
  { value: "legacy", label: "replays.search.status.legacy" },
  { value: "broken", label: "replays.search.status.broken" },
];

const MIN_RATING = -1000;
const MAX_RATING = 4000;

const isoDaysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

interface Props {
  initialQuery: LocalReplayQuery;
  self: string;
  featuredMods: string[];
  loading: boolean;
  busy: boolean;
  onSearch: (query: LocalReplayQuery) => void;
  onRefresh: () => void;
  onOpenFile: () => void;
}

export function LocalReplaySearch({
  initialQuery,
  self,
  featuredMods,
  loading,
  busy,
  onSearch,
  onRefresh,
  onOpenFile,
}: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState(initialQuery);
  const [advanced, setAdvanced] = useState(false);

  const set = <K extends keyof LocalReplayQuery>(key: K, value: LocalReplayQuery[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const setRange = (low: number | null, high: number | null) =>
    setForm((current) => ({ ...current, minRating: low, maxRating: high }));

  const apply = (query: LocalReplayQuery) => {
    setForm(query);
    onSearch(query);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    onSearch(form);
  };

  const toggleSortDirection = () => {
    const query = { ...form, sortDescending: !form.sortDescending };
    apply(query);
  };

  const hiddenFilterCount = localReplayAdvancedFilterCount(form);

  return (
    <form className="vault-search local-vault-search search-panel surface-panel" onSubmit={submit}>
      <div className="vault-search-primary search-panel-primary">
        <label className="vault-field vault-field-grow search-panel-field search-panel-field-grow">
          <span className="vault-field-label search-panel-label">{t("replays.search.player")}</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            value={form.player}
            placeholder={t("replays.search.anyPlayer")}
            onChange={(event) => set("player", event.target.value)}
          />
        </label>

        <label className="vault-field vault-field-grow search-panel-field search-panel-field-grow">
          <span className="vault-field-label search-panel-label">{t("replays.search.map")}</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            value={form.map}
            placeholder={t("replays.search.anyMap")}
            onChange={(event) => set("map", event.target.value)}
          />
        </label>

        <label className="vault-field vault-search-replay-id search-panel-field">
          <span className="vault-field-label search-panel-label">{t("replays.search.replayId")}</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            inputMode="numeric"
            value={form.replayId}
            onChange={(event) => set("replayId", event.target.value)}
          />
        </label>

        <label className="vault-field local-vault-mod search-panel-field">
          <span className="vault-field-label search-panel-label">{t("replays.search.mod")}</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            list="local-replay-mod-options"
            value={form.mod}
            placeholder={t("replays.search.anyMod")}
            onChange={(event) => set("mod", event.target.value)}
          />
          <datalist id="local-replay-mod-options">
            {featuredMods.map((mod) => <option value={mod} key={mod} />)}
          </datalist>
        </label>

        <div className="vault-search-rating search-panel-field">
          <RangeSlider
            label={t("replays.search.rating")}
            min={MIN_RATING}
            max={MAX_RATING}
            step={50}
            low={form.minRating}
            high={form.maxRating}
            onChange={setRange}
          />
        </div>

        <label className="vault-field local-vault-status search-panel-field">
          <span className="vault-field-label search-panel-label">{t("replays.search.status")}</span>
          <select
            className="vault-input search-panel-control"
            value={form.status}
            onChange={(event) => set("status", event.target.value as LocalReplayQuery["status"])}
          >
            {STATUS_OPTIONS.map((option) => (
              <option value={option.value} key={option.value}>{t(option.label)}</option>
            ))}
          </select>
        </label>

        <label className="vault-field search-panel-field">
          <span className="vault-field-label search-panel-label">{t("replays.search.sortBy")}</span>
          <select
            className="vault-input search-panel-control"
            value={form.sortBy}
            onChange={(event) => set("sortBy", event.target.value as LocalReplaySortField)}
          >
            {(Object.keys(SORT_LABELS) as LocalReplaySortField[]).map((field) => (
              <option value={field} key={field}>{t(SORT_LABELS[field])}</option>
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
        <Button type="button" onClick={() => apply(EMPTY_LOCAL_REPLAY_QUERY)}>{t("replays.search.preset.newest")}</Button>
        <Button type="button" onClick={() => apply({ ...EMPTY_LOCAL_REPLAY_QUERY, after: isoDaysAgo(365) })}>{t("replays.search.preset.lastYear")}</Button>
        <Button
          type="button"
          disabled={!self}
          onClick={() => apply({ ...EMPTY_LOCAL_REPLAY_QUERY, player: self, exactPlayer: true })}
        >
          {t("replays.search.preset.myReplays")}
        </Button>
        <span className="spacer" />
        <button
          type="button"
          className="vault-toggle-advanced search-panel-toggle"
          aria-expanded={advanced}
          onClick={() => setAdvanced((current) => !current)}
        >
          <Icon name="filter" size={14} />
          {advanced
            ? t("replays.search.fewerFilters")
            : hiddenFilterCount
              ? t("replays.search.moreFiltersCount", { count: hiddenFilterCount })
              : t("replays.search.moreFilters")}
        </button>
        <Button type="button" onClick={() => apply(EMPTY_LOCAL_REPLAY_QUERY)}>{t("replays.search.clear")}</Button>
        <Button type="button" disabled={loading} onClick={onRefresh}><Icon name="refresh" size={15} /> {t("replays.search.refresh")}</Button>
        <Button type="button" variant="primary" disabled={busy} onClick={onOpenFile}>{t("replays.search.openFile")}</Button>
      </div>

      {advanced && (
        <div className="vault-search-advanced search-panel-advanced">
          <div className="vault-search-fields local-vault-search-fields">
            <label className="vault-field">
              <span className="vault-field-label">{t("replays.search.gameTitle")}</span>
              <input className="vault-input" type="search" value={form.title} onChange={(event) => set("title", event.target.value)} />
            </label>
            <label className="vault-field">
              <span className="vault-field-label">{t("replays.search.recorder")}</span>
              <input className="vault-input" type="search" value={form.recorder} onChange={(event) => set("recorder", event.target.value)} />
            </label>
            <label className="vault-field">
              <span className="vault-field-label">{t("replays.search.simMod")}</span>
              <input className="vault-input" type="search" value={form.simMod} onChange={(event) => set("simMod", event.target.value)} />
            </label>
            <label className="vault-field">
              <span className="vault-field-label">{t("replays.search.playedAfter")}</span>
              <input className="vault-input" type="date" value={form.after} onChange={(event) => set("after", event.target.value)} />
            </label>
            <label className="vault-field">
              <span className="vault-field-label">{t("replays.search.playedBefore")}</span>
              <input className="vault-input" type="date" value={form.before} onChange={(event) => set("before", event.target.value)} />
            </label>
          </div>
          <div className="vault-search-checks">
            <label className="option-check">
              <input type="checkbox" checked={form.exactPlayer} onChange={(event) => set("exactPlayer", event.target.checked)} />
              {t("replays.search.exactPlayer")}
            </label>
            <label className="option-check">
              <input type="checkbox" checked={form.onlyWatchable} onChange={(event) => set("onlyWatchable", event.target.checked)} />
              {t("replays.search.watchableOnly")}
            </label>
          </div>
        </div>
      )}
    </form>
  );
}
