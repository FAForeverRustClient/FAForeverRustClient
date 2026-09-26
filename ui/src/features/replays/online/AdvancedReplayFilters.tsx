import type { ReplayQuery } from "../../../ipc/bindings";
import { MultiSelect, type MultiSelectOption } from "../../../design-system/MultiSelect";
import { ManageReplayTagsButton } from "../ReplayTagsDialog";
import { RangeSlider } from "../../../design-system/RangeSlider";
import { FACTION_OPTIONS } from "../../../shared/factions";
import type { MessageKey } from "../../../i18n";
import { useTranslation } from "../../../i18n/useTranslation";

/** The host dialog's game types, in its order. */
const GAME_TYPES: { id: string; label: MessageKey }[] = [
  { id: "faf", label: "lobby.host.mod.faf" },
  { id: "fafbeta", label: "lobby.host.mod.fafbeta" },
  { id: "fafdevelop", label: "lobby.host.mod.fafdevelop" },
  { id: "nomads", label: "lobby.host.mod.nomads" },
];
const GAME_TYPE_IDS = new Set(GAME_TYPES.map((type) => type.id));

/** Featured mods the game-mode picker already offers. */
const IN_GAME_MODES = new Set(["coop", "ladder1v1"]);

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

export function AdvancedReplayFilters({ form, featuredMods, set, setRange, tagOptions, selectedTags, onTags }: Props) {
  const { t } = useTranslation();
  // Built per render so the captions follow the selected language.
  const VICTORY_OPTIONS: MultiSelectOption[] = VICTORY_OPTION_KEYS.map(
    (option) => ({ value: option.value, label: t(option.label) }),
  );
  const gameTypeOptions: MultiSelectOption[] = GAME_TYPES.map((type) => ({ value: type.id, label: t(type.label) }));
  // Every other featured mod the vault knows: a whole different game built on
  // FA rather than a version of FAF. The two the game-mode picker already
  // offers are left out, so nothing can be asked for in two places.
  const moddedOptions: MultiSelectOption[] = featuredMods
    .filter((mod) => !GAME_TYPE_IDS.has(mod) && !IN_GAME_MODES.has(mod))
    .map((mod) => ({ value: mod, label: mod }));
  // Both pickers write the one `featuredMods` list the query carries, each
  // keeping the other's half of it.
  const pickFeatured = (within: MultiSelectOption[], picked: string[]) => {
    const own = new Set(within.map((option) => option.value));
    set("featuredMods", [...form.featuredMods.filter((mod) => !own.has(mod)), ...picked]);
  };
  const pickedFrom = (within: MultiSelectOption[]) =>
    form.featuredMods.filter((mod) => within.some((option) => option.value === mod));
  return (
    <div className="vault-search-advanced search-panel-advanced">
      <div className="vault-search-sliders">
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
        <RangeSlider
          label={t("replays.filters.mapSlots")}
          min={2}
          max={MAX_MAP_PLAYERS}
          step={1}
          low={form.mapMinPlayers}
          high={form.mapMaxPlayers}
          onChange={(lo, hi) => setRange("mapMinPlayers", "mapMaxPlayers", lo, hi)}
        />
        {/* Not the same filter as the one above, and the difference is the
            request: a search for a map comes back full of two-player test
            lobbies hosted on a sixteen-slot map, and the slot count cannot
            tell those from the sixteen-player game somebody wanted. */}
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
          format={(v) => `${v} km`}
          onChange={(lo, hi) => setRange("mapMinSizeKm", "mapMaxSizeKm", lo, hi)}
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

        <label className="vault-field">
          <span className="vault-field-label">{t("replays.filters.gameTitle")}</span>
          <input
            className="vault-input"
            type="search"
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
          />
        </label>

        {/* The reader's own tags (#324). The vault has never heard of them,
            so the picked tags become the ids of the games carrying them, and
            the search asks for exactly those. */}
        <div className="vault-field">
          <MultiSelect
            label={t("replays.filters.yourTags")}
            anyLabel={t("replays.filters.anyTag")}
            options={tagOptions.map((tag) => ({ value: tag, label: tag }))}
            selected={selectedTags}
            onChange={onTags}
          />
          <ManageReplayTagsButton />
        </div>

        <div className="vault-field">
          <MultiSelect
            label={t("replays.filters.faction")}
            options={FACTION_OPTIONS}
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

        {/* Down here, where the date range used to be, and for the reason the
            thread gave: the featured mod is how somebody finds a `fafbeta` or
            `fafdevelop` game, which is a real search and a rare one, while the
            date is the bound half the searches in this vault want. The two
            swapped rows. */}
        {/* "Game type" is what a game is, and the host dialog's four are all
            there are: FAF, its beta and develop balances, and Nomads (#343).
            Everything else the vault calls a featured mod is its own game,
            under "Modded games". Co-op and the ladder are neither, since the
            game-mode picker above already asks for them. Sim mods such as
            Total Mayhem cannot be filtered on at all: the vault does not
            record which ones a game ran with. */}
        <div className="vault-field">
          <MultiSelect
            label={t("lobby.host.gameType")}
            options={gameTypeOptions}
            selected={pickedFrom(gameTypeOptions)}
            onChange={(picked) => pickFeatured(gameTypeOptions, picked)}
          />
        </div>

        <div className="vault-field">
          <MultiSelect
            label={t("replays.filters.moddedGames")}
            options={moddedOptions}
            selected={pickedFrom(moddedOptions)}
            onChange={(picked) => pickFeatured(moddedOptions, picked)}
          />
        </div>

        <label className="vault-field">
          <span className="vault-field-label">{t("replays.filters.resultsPerPage")}</span>
          <select
            className="vault-input"
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
