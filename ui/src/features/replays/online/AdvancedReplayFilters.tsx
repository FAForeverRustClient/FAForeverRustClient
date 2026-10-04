import type { ReplayQuery } from "../../../ipc/bindings";
import { MultiSelect, type MultiSelectOption } from "../../../design-system/MultiSelect";
import { ReplayTagFilter } from "../ReplayTagsDialog";
import { RangeSlider } from "../../../design-system/RangeSlider";
import { factionOptions } from "../../../shared/factions";
import { kilometres } from "../../../shared/mapPresentation";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";

/** The host dialog's game types, in its order. */
const GAME_TYPES: { id: string; label: MessageKey }[] = [
  { id: "faf", label: "lobby.host.mod.faf" },
  { id: "fafbeta", label: "lobby.host.mod.fafbeta" },
  { id: "fafdevelop", label: "lobby.host.mod.fafdevelop" },
  { id: "nomads", label: "lobby.host.mod.nomads" },
];

const MAX_DURATION_MINUTES = 60;
const MAX_MAP_SIZE_KM = 40;
const MAX_MAP_PLAYERS = 16;

const VICTORY_OPTION_KEYS: { value: string; label: MessageKey }[] = [
  { value: "DEMORALIZATION", label: "replays.filters.victory.assassination" },
  { value: "DOMINATION", label: "replays.filters.victory.supremacy" },
  { value: "ERADICATION", label: "replays.filters.victory.annihilation" },
  { value: "SANDBOX", label: "replays.filters.victory.sandbox" },
];

interface Props {
  form: ReplayQuery;
  /** Featured mod technical names from the API, for the mod filter below. */
  featuredMods: string[];
  set: <K extends keyof ReplayQuery>(key: K, value: ReplayQuery[K]) => void;
  setRange: (
    lowKey: keyof ReplayQuery,
    highKey: keyof ReplayQuery,
    low: number | null,
    high: number | null,
  ) => void;
  /** Every tag the reader has put on a replay (#324). */
  tagOptions: string[];
  selectedTags: string[];
  onTags: (tags: string[]) => void;
}

/**
 * The four ranges that sit in the search panel's always-visible second row,
 * beside the rating: how long the game ran, how many played it, how big the
 * map is, and what the community thought of it. They lived behind "More
 * filters", where a filter nobody could see was a filter nobody set.
 */
export function ReplaySearchSliders({ form, setRange }: Pick<Props, "form" | "setRange">) {
  const { t } = useTranslation();
  return (
    <>
      <RangeSlider
        label={t("replays.filters.duration")}
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
      {/* Not the same filter as the map's slot count in "More filters", and
          the difference is the request: a search for a map comes back full of
          two-player test lobbies hosted on a sixteen-slot map, and the slot
          count cannot tell those from the sixteen-player game somebody
          wanted. */}
      <RangeSlider
        label={t("replays.filters.playerCount")}
        min={1}
        max={MAX_MAP_PLAYERS}
        step={1}
        low={form.minPlayers}
        high={form.maxPlayers}
        onChange={(lo, hi) => setRange("minPlayers", "maxPlayers", lo, hi)}
      />
      <RangeSlider
        label={t("replays.filters.mapSize")}
        min={0}
        max={MAX_MAP_SIZE_KM}
        step={1}
        low={form.mapMinSizeKm}
        high={form.mapMaxSizeKm}
        format={kilometres}
        onChange={(lo, hi) => setRange("mapMinSizeKm", "mapMaxSizeKm", lo, hi)}
      />
      <RangeSlider
        label={t("replays.filters.reviewScore")}
        min={0}
        max={5}
        step={0.5}
        low={form.minReviewScore}
        high={form.maxReviewScore}
        format={(v) => `${v}★`}
        onChange={(lo, hi) => setRange("minReviewScore", "maxReviewScore", lo, hi)}
      />
    </>
  );
}

/**
 * Game type and results per page, for the search panel's first row: both are
 * asked often enough that hiding them behind "More filters" cost a click
 * every time.
 */
export function ReplayTypeAndPageSize({ form, featuredMods, set }: Pick<Props, "form" | "featuredMods" | "set">) {
  const { t } = useTranslation();
  // The host dialog's four, in its order, less any the vault does not list:
  // a type the vault has no games of is a filter that can only come back
  // empty. Until the list has loaded all four are offered.
  const gameTypeOptions: MultiSelectOption[] = GAME_TYPES
    .filter((type) => featuredMods.length === 0 || featuredMods.includes(type.id))
    .map((type) => ({ value: type.id, label: t(type.label) }));
  // The picker writes the one `featuredMods` list the query carries, keeping
  // what else is in it: the game-mode picker beside it puts co-op there.
  const pickFeatured = (picked: string[]) => {
    const own = new Set(gameTypeOptions.map((option) => option.value));
    set("featuredMods", [...form.featuredMods.filter((mod) => !own.has(mod)), ...picked]);
  };
  const picked = form.featuredMods.filter((mod) => gameTypeOptions.some((option) => option.value === mod));
  return (
    <>
      {/* "Game type" is what a game is, and the host dialog's four are all
          there are: FAF, its beta and develop balances, and Nomads (#343).
          The vault's other featured mods (Phantom-X, Murderparty and the
          like) are not offered: searching for them turned up no replays, and
          a filter that only comes back empty is worse than none. Sim mods
          such as Total Mayhem cannot be filtered on at all: the vault does
          not record which ones a game ran with. */}
      <div className="vault-field vault-search-mode search-panel-field">
        <MultiSelect
          label={t("lobby.host.gameType")}
          options={gameTypeOptions}
          selected={picked}
          onChange={pickFeatured}
        />
      </div>

      <label className="vault-field vault-search-page-size search-panel-field">
        <span className="vault-field-label search-panel-label">{t("replays.filters.resultsPerPage")}</span>
        <select
          className="vault-input search-panel-control"
          value={form.pageSize}
          onChange={(e) => set("pageSize", Number(e.target.value))}
        >
          {/* 100 is the ceiling because it is the API's: a larger
              `page[size]` is rewritten server side without a word about it,
              so "200 per page" returned 100 rows and made the second half of
              every result set unreachable, the pager still counting in
              200s. */}
          {[25, 50, 100].map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

export function AdvancedReplayFilters({ form, set, setRange, tagOptions, selectedTags, onTags }: Omit<Props, "featuredMods">) {
  const { t } = useTranslation();
  // Built per render so the captions follow the selected language.
  const VICTORY_OPTIONS: MultiSelectOption[] = VICTORY_OPTION_KEYS.map(
    (option) => ({ value: option.value, label: t(option.label) }),
  );
  return (
    <div className="vault-search-advanced search-panel-advanced">
      {/* The rest of the ranges are in the always-visible row: see
          `ReplaySearchSliders`. The map's slot count stays here, as the rarer
          question. */}
      <div className="vault-search-sliders">
        <RangeSlider
          label={t("replays.filters.mapSlots")}
          min={2}
          max={MAX_MAP_PLAYERS}
          step={1}
          low={form.mapMinPlayers}
          high={form.mapMaxPlayers}
          onChange={(lo, hi) => setRange("mapMinPlayers", "mapMaxPlayers", lo, hi)}
        />
      </div>

      <div className="vault-search-fields">
        <label className="vault-field">
          <span className="vault-field-label">{t("replays.filters.host")}</span>
          <input
            className="vault-input"
            type="search"
            value={form.host}
            onChange={(e) => set("host", e.target.value)}
          />
        </label>

        <label className="vault-field">
          <span className="vault-field-label">{t("replays.filters.mapAuthor")}</span>
          <input
            className="vault-input"
            type="search"
            value={form.mapAuthor}
            onChange={(e) => set("mapAuthor", e.target.value)}
          />
        </label>

        {/* The reader's own tags (#324). The vault has never heard of them,
            so the picked tags become the ids of the games carrying them, and
            the search asks for exactly those. */}
        <div className="vault-field">
          <ReplayTagFilter options={tagOptions} selected={selectedTags} onChange={onTags} />
        </div>

        <div className="vault-field">
          <MultiSelect
            label={t("replays.filters.faction")}
            options={factionOptions()}
            selected={form.factions.map(String)}
            onChange={(v) => set("factions", v.map(Number))}
          />
        </div>

        <div className="vault-field">
          <MultiSelect
            label={t("replays.filters.victoryCondition")}
            options={VICTORY_OPTIONS}
            selected={form.victoryConditions}
            onChange={(v) => set("victoryConditions", v)}
          />
        </div>

      </div>

      <div className="vault-search-checks">
        <label className="option-check">
          <input
            type="checkbox"
            checked={form.exactPlayer}
            onChange={(e) => set("exactPlayer", e.target.checked)}
          />
          {t("replays.filters.exactPlayerName")}
        </label>
        <label className="option-check">
          <input
            type="checkbox"
            checked={form.onlyRanked}
            onChange={(e) => set("onlyRanked", e.target.checked)}
          />
          {t("replays.filters.rankedGamesOnly")}
        </label>
        <label className="option-check">
          <input
            type="checkbox"
            checked={form.rankedMapOnly}
            onChange={(e) => set("rankedMapOnly", e.target.checked)}
          />
          {t("replays.filters.rankedMapsOnly")}
        </label>
      </div>

      {/* One filter the API cannot answer, so the client applies it to the
          page it got back. That makes a page shorter than the page size, which
          looks like a bug unless the form says otherwise. */}
      {hasLocalFilter(form) && (
        <p className="muted vault-search-note">{t("replays.filters.localFilterNote")}</p>
      )}

      {/* The one piece of behaviour that is invisible but load-bearing:
          both reference clients cap an otherwise unbounded filtered search
          to the recent past so the API doesn't time out. Saying so beats
          having the user wonder where their 2019 replays went. */}
      {!form.after && hasNarrowingFilter(form) && (
        <p className="muted vault-search-note">
          {t(form.player
            ? "replays.filters.dateFloorWithPlayer"
            : "replays.filters.dateFloor")}
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
    q.minPlayers !== null ||
    q.maxPlayers !== null ||
    q.mapMinSizeKm !== null ||
    q.mapMaxSizeKm !== null ||
    q.rankedMapOnly ||
    q.onlyRanked
  );
}

/** Mirrors `ReplayQuery::has_local_filter` in faf-domain. */
/** Mirrors `ReplayQuery::has_local_filter`: the one filter the API cannot do. */
function hasLocalFilter(q: ReplayQuery): boolean {
  return q.minPlayers !== null || q.maxPlayers !== null;
}
