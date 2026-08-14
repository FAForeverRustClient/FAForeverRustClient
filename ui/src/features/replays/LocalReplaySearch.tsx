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

const SORT_LABELS: Record<LocalReplaySortField, string> = {
  date: "Date played",
  title: "Game title",
  map: "Map name",
  players: "Player count",
  size: "File size",
};

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
          <span className="vault-field-label search-panel-label">Player</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            value={form.player}
            placeholder="Any player"
            onChange={(event) => set("player", event.target.value)}
          />
        </label>

        <label className="vault-field vault-field-grow search-panel-field search-panel-field-grow">
          <span className="vault-field-label search-panel-label">Map</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            value={form.map}
            placeholder="Any map"
            onChange={(event) => set("map", event.target.value)}
          />
        </label>

        <label className="vault-field vault-search-replay-id search-panel-field">
          <span className="vault-field-label search-panel-label">Replay ID</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            inputMode="numeric"
            value={form.replayId}
            onChange={(event) => set("replayId", event.target.value)}
          />
        </label>

        <label className="vault-field local-vault-mod search-panel-field">
          <span className="vault-field-label search-panel-label">Mod</span>
          <input
            className="vault-input search-panel-control"
            type="search"
            list="local-replay-mod-options"
            value={form.mod}
            placeholder="Any"
            onChange={(event) => set("mod", event.target.value)}
          />
          <datalist id="local-replay-mod-options">
            {featuredMods.map((mod) => <option value={mod} key={mod} />)}
          </datalist>
        </label>

        <div className="vault-search-rating search-panel-field">
          <RangeSlider
            label="Rating"
            min={MIN_RATING}
            max={MAX_RATING}
            step={50}
            low={form.minRating}
            high={form.maxRating}
            onChange={setRange}
          />
        </div>

        <label className="vault-field local-vault-status search-panel-field">
          <span className="vault-field-label search-panel-label">Status</span>
          <select
            className="vault-input search-panel-control"
            value={form.status}
            onChange={(event) => set("status", event.target.value as LocalReplayQuery["status"])}
          >
            <option value="all">All files</option>
            <option value="complete">Complete</option>
            <option value="incomplete">Incomplete metadata</option>
            <option value="legacy">Legacy</option>
            <option value="broken">Parse errors</option>
          </select>
        </label>

        <label className="vault-field search-panel-field">
          <span className="vault-field-label search-panel-label">Sort by</span>
          <select
            className="vault-input search-panel-control"
            value={form.sortBy}
            onChange={(event) => set("sortBy", event.target.value as LocalReplaySortField)}
          >
            {(Object.keys(SORT_LABELS) as LocalReplaySortField[]).map((field) => (
              <option value={field} key={field}>{SORT_LABELS[field]}</option>
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
        <Button type="button" onClick={() => apply(EMPTY_LOCAL_REPLAY_QUERY)}>Newest</Button>
        <Button type="button" onClick={() => apply({ ...EMPTY_LOCAL_REPLAY_QUERY, after: isoDaysAgo(365) })}>Last year</Button>
        <Button
          type="button"
          disabled={!self}
          onClick={() => apply({ ...EMPTY_LOCAL_REPLAY_QUERY, player: self, exactPlayer: true })}
        >
          My replays
        </Button>
        <span className="spacer" />
        <button
          type="button"
          className="vault-toggle-advanced search-panel-toggle"
          aria-expanded={advanced}
          onClick={() => setAdvanced((current) => !current)}
        >
          <Icon name="filter" size={14} />
          {advanced ? "Fewer filters" : `More filters${hiddenFilterCount ? ` (${hiddenFilterCount})` : ""}`}
        </button>
        <Button type="button" onClick={() => apply(EMPTY_LOCAL_REPLAY_QUERY)}>Clear</Button>
        <Button type="button" disabled={loading} onClick={onRefresh}><Icon name="refresh" size={15} /> Refresh</Button>
        <Button type="button" variant="primary" disabled={busy} onClick={onOpenFile}>Open file…</Button>
      </div>

      {advanced && (
        <div className="vault-search-advanced search-panel-advanced">
          <div className="vault-search-fields local-vault-search-fields">
            <label className="vault-field">
              <span className="vault-field-label">Game title</span>
              <input className="vault-input" type="search" value={form.title} onChange={(event) => set("title", event.target.value)} />
            </label>
            <label className="vault-field">
              <span className="vault-field-label">Recorder</span>
              <input className="vault-input" type="search" value={form.recorder} onChange={(event) => set("recorder", event.target.value)} />
            </label>
            <label className="vault-field">
              <span className="vault-field-label">Simulation mod</span>
              <input className="vault-input" type="search" value={form.simMod} onChange={(event) => set("simMod", event.target.value)} />
            </label>
            <label className="vault-field">
              <span className="vault-field-label">Played after</span>
              <input className="vault-input" type="date" value={form.after} onChange={(event) => set("after", event.target.value)} />
            </label>
            <label className="vault-field">
              <span className="vault-field-label">Played before</span>
              <input className="vault-input" type="date" value={form.before} onChange={(event) => set("before", event.target.value)} />
            </label>
          </div>
          <div className="vault-search-checks">
            <label className="option-check">
              <input type="checkbox" checked={form.exactPlayer} onChange={(event) => set("exactPlayer", event.target.checked)} />
              Exact player name
            </label>
            <label className="option-check">
              <input type="checkbox" checked={form.onlyWatchable} onChange={(event) => set("onlyWatchable", event.target.checked)} />
              Watchable files only
            </label>
          </div>
        </div>
      )}
    </form>
  );
}
