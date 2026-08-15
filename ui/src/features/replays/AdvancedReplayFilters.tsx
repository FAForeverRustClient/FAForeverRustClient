import type { ReplayQuery } from "../../ipc/bindings";
import { MultiSelect, type MultiSelectOption } from "../../design-system/MultiSelect";
import { RangeSlider } from "../../design-system/RangeSlider";
import { FACTION_OPTIONS } from "../../shared/factions";

const MAX_DURATION_MINUTES = 60;
const MAX_MAP_SIZE_KM = 40;
const MAX_MAP_PLAYERS = 16;

const VICTORY_OPTIONS: MultiSelectOption[] = [
  { value: "DEMORALIZATION", label: "Assassination" },
  { value: "DOMINATION", label: "Supremacy" },
  { value: "ERADICATION", label: "Annihilation" },
  { value: "SANDBOX", label: "Sandbox" },
];

interface Props {
  form: ReplayQuery;
  set: <K extends keyof ReplayQuery>(key: K, value: ReplayQuery[K]) => void;
  setRange: (
    lowKey: keyof ReplayQuery,
    highKey: keyof ReplayQuery,
    low: number | null,
    high: number | null,
  ) => void;
}

export function AdvancedReplayFilters({ form, set, setRange }: Props) {
  return (
    <div className="vault-search-advanced search-panel-advanced">
      <div className="vault-search-sliders">
        <RangeSlider
          label="Duration"
          min={0}
          max={MAX_DURATION_MINUTES}
          step={1}
          low={form.minDurationMinutes}
          high={form.maxDurationMinutes}
          format={(v) => `${v} min`}
          onChange={(lo, hi) =>
            setRange("minDurationMinutes", "maxDurationMinutes", lo, hi)
          }
        />
        <RangeSlider
          label="Review score"
          min={0}
          max={5}
          step={0.5}
          low={form.minReviewScore}
          high={form.maxReviewScore}
          format={(v) => `${v}★`}
          onChange={(lo, hi) => setRange("minReviewScore", "maxReviewScore", lo, hi)}
        />
        <RangeSlider
          label="Map slots"
          min={2}
          max={MAX_MAP_PLAYERS}
          step={1}
          low={form.mapMinPlayers}
          high={form.mapMaxPlayers}
          onChange={(lo, hi) => setRange("mapMinPlayers", "mapMaxPlayers", lo, hi)}
        />
        <RangeSlider
          label="Map size"
          min={0}
          max={MAX_MAP_SIZE_KM}
          step={1}
          low={form.mapMinSizeKm}
          high={form.mapMaxSizeKm}
          format={(v) => `${v} km`}
          onChange={(lo, hi) => setRange("mapMinSizeKm", "mapMaxSizeKm", lo, hi)}
        />
      </div>

      <div className="vault-search-fields">
        <label className="vault-field">
          <span className="vault-field-label">Host</span>
          <input
            className="vault-input"
            type="search"
            value={form.host}
            onChange={(e) => set("host", e.target.value)}
          />
        </label>

        <label className="vault-field">
          <span className="vault-field-label">Map author</span>
          <input
            className="vault-input"
            type="search"
            value={form.mapAuthor}
            onChange={(e) => set("mapAuthor", e.target.value)}
          />
        </label>

        <label className="vault-field">
          <span className="vault-field-label">Game title</span>
          <input
            className="vault-input"
            type="search"
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
          />
        </label>

        <div className="vault-field">
          <MultiSelect
            label="Faction"
            options={FACTION_OPTIONS}
            selected={form.factions.map(String)}
            onChange={(v) => set("factions", v.map(Number))}
          />
        </div>

        <div className="vault-field">
          <MultiSelect
            label="Victory condition"
            options={VICTORY_OPTIONS}
            selected={form.victoryConditions}
            onChange={(v) => set("victoryConditions", v)}
          />
        </div>

        <label className="vault-field">
          <span className="vault-field-label">Played after</span>
          <input
            className="vault-input"
            type="date"
            value={form.after}
            onChange={(e) => set("after", e.target.value)}
          />
        </label>

        <label className="vault-field">
          <span className="vault-field-label">Played before</span>
          <input
            className="vault-input"
            type="date"
            value={form.before}
            onChange={(e) => set("before", e.target.value)}
          />
        </label>

        <label className="vault-field">
          <span className="vault-field-label">Results per page</span>
          <select
            className="vault-input"
            value={form.pageSize}
            onChange={(e) => set("pageSize", Number(e.target.value))}
          >
            {[25, 50, 100, 200].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="vault-search-checks">
        <label className="option-check">
          <input
            type="checkbox"
            checked={form.exactPlayer}
            onChange={(e) => set("exactPlayer", e.target.checked)}
          />
          Exact player name
        </label>
        <label className="option-check">
          <input
            type="checkbox"
            checked={form.onlyRanked}
            onChange={(e) => set("onlyRanked", e.target.checked)}
          />
          Ranked games only
        </label>
        <label className="option-check">
          <input
            type="checkbox"
            checked={form.rankedMapOnly}
            onChange={(e) => set("rankedMapOnly", e.target.checked)}
          />
          Ranked maps only
        </label>
      </div>

      {/* The one piece of behaviour that is invisible but load-bearing:
          both reference clients cap an otherwise unbounded filtered search
          to the recent past so the API doesn't time out. Saying so beats
          having the user wonder where their 2019 replays went. */}
      {!form.after && hasNarrowingFilter(form) && (
        <p className="muted vault-search-note">
          Filtered searches without a start date only look back{" "}
          {form.player ? "six months" : "three months"}; set “Played after” to search
          further back.
        </p>
      )}
    </div>
  );
}

/** Mirrors `ReplayQuery::has_narrowing_filter` in faf-domain. */
function hasNarrowingFilter(q: ReplayQuery): boolean {
  return (
    !!q.player ||
    !!q.map ||
    !!q.mapAuthor ||
    !!q.title ||
    !!q.replayId ||
    !!q.host ||
    q.featuredMods.length > 0 ||
    q.leaderboards.length > 0 ||
    q.factions.length > 0 ||
    q.victoryConditions.length > 0 ||
    q.minRating !== null ||
    q.maxRating !== null ||
    q.minReviewScore !== null ||
    q.maxReviewScore !== null ||
    q.minDurationMinutes !== null ||
    q.maxDurationMinutes !== null ||
    q.mapMinPlayers !== null ||
    q.mapMaxPlayers !== null ||
    q.mapMinSizeKm !== null ||
    q.mapMaxSizeKm !== null ||
    q.rankedMapOnly ||
    q.onlyRanked
  );
}
