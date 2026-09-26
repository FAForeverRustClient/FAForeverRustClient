import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { MultiSelect } from "../../../design-system/MultiSelect";
import {
  filterChoices,
  joinFilterChoices,
  prettyFeaturedMod,
  prettyGameType,
  type LiveFilters,
} from "../../../shared/liveReplayModel";
import { ReplayViewSwitch, type ReplayViewMode } from "../ReplayViewSwitch";
import { useTranslation } from "../../../i18n/useTranslation";

interface Props {
  filters: LiveFilters;
  filtersOpen: boolean;
  activeFilterCount: number;
  gameTypes: string[];
  featuredMods: string[];
  activePlayerOptions: number[];
  maxPlayerOptions: number[];
  viewMode: ReplayViewMode;
  onFilter: <K extends keyof LiveFilters>(key: K, value: LiveFilters[K]) => void;
  onToggleFilters: () => void;
  onClear: () => void;
  onViewMode: (mode: ReplayViewMode) => void;
}

export function LiveReplayControls(props: Props) {
  const { t } = useTranslation();
  const { filters, onFilter } = props;
  return (
    <>
      <div className="live-replay-toolbar">
        <label className="search-field live-replay-search">
          <Icon name="search" size={15} />
          <input
            value={filters.search}
            onChange={(event) => onFilter("search", event.target.value)}
            placeholder={t("replays.live.searchPlaceholder")}
            aria-label={t("replays.live.searchAria")}
          />
        </label>
        <label className="toolbar-check">
          <input
            type="checkbox"
            checked={filters.hideModded}
            onChange={(event) => onFilter("hideModded", event.target.checked)}
          />
          {t("replays.live.hideModded")}
        </label>
        <label className="toolbar-check">
          <input
            type="checkbox"
            checked={filters.hideSinglePlayer}
            onChange={(event) => onFilter("hideSinglePlayer", event.target.checked)}
          />
          {t("replays.live.hideSinglePlayer")}
        </label>
        <label className="toolbar-check">
          <input
            type="checkbox"
            checked={filters.friendsOnly}
            onChange={(event) => onFilter("friendsOnly", event.target.checked)}
          />
          {t("replays.live.friendsOnly")}
        </label>
        <Button
          className={props.filtersOpen ? "live-filter-button active" : "live-filter-button"}
          aria-expanded={props.filtersOpen}
          onClick={props.onToggleFilters}
        >
          <Icon name="filter" size={15} />
          {props.activeFilterCount > 0
            ? t("replays.live.filtersCount", { count: props.activeFilterCount })
            : t("replays.live.filters")}
        </Button>
        {props.activeFilterCount > 0 && <Button onClick={props.onClear}>{t("replays.live.clear")}</Button>}
        <span className="live-replay-stream-status">
          <i aria-hidden="true" /> {t("replays.live.updates")}
        </span>
        {/* Same control, same place, same stored preference as the two other
            replay tabs: the answer to "list or cards" is about the reader
            rather than about which tab they are on. */}
        <ReplayViewSwitch value={props.viewMode} onChange={props.onViewMode} />
      </div>

      {/* Checkbox lists rather than single selects (#326): "custom and
          matchmaker, but not co-op" is one question, and a single select could
          only answer it as "everything". Nothing ticked still means any. */}
      {props.filtersOpen && (
        <div className="live-replay-filters surface-panel">
          <MultiSelect
            label={t("replays.live.gameType")}
            anyLabel={t("replays.live.anyType")}
            options={withChosen(props.gameTypes, filters.gameType).map((type) => ({ value: type, label: prettyGameType(type) }))}
            selected={filterChoices(filters.gameType)}
            onChange={(values) => onFilter("gameType", joinFilterChoices(values))}
          />
          <MultiSelect
            label={t("replays.live.featuredMod")}
            anyLabel={t("replays.live.anyMod")}
            options={withChosen(props.featuredMods, filters.featuredMod).map((mod) => ({ value: mod, label: prettyFeaturedMod(mod) }))}
            selected={filterChoices(filters.featuredMod)}
            onChange={(values) => onFilter("featuredMod", joinFilterChoices(values))}
          />
          <MultiSelect
            label={t("replays.live.activePlayers")}
            anyLabel={t("replays.live.anyCount")}
            options={withChosen(props.activePlayerOptions.map(String), filters.activePlayers).map((count) => ({ value: count, label: count }))}
            selected={filterChoices(filters.activePlayers)}
            onChange={(values) => onFilter("activePlayers", joinFilterChoices(values))}
          />
          <MultiSelect
            label={t("replays.live.gameSize")}
            anyLabel={t("replays.live.anySize")}
            options={withChosen(props.maxPlayerOptions.map(String), filters.maxPlayers).map((count) => ({
              value: count,
              label: t("replays.live.slots", { count: Number(count) }),
            }))}
            selected={filterChoices(filters.maxPlayers)}
            onChange={(values) => onFilter("maxPlayers", joinFilterChoices(values))}
          />
        </div>
      )}
    </>
  );
}

/**
 * The options the live list offers, plus any saved choice it no longer does.
 *
 * The lists are built from the games running right now, so a saved choice can
 * outlive every game that had it. Left out of the options, it would still be
 * filtering while no checkbox showed it ticked, and nothing could untick it.
 */
function withChosen(options: string[], stored: string): string[] {
  const missing = filterChoices(stored).filter((choice) => !options.includes(choice));
  return [...options, ...missing];
}
