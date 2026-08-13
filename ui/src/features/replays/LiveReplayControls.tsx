import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { prettyGameType, type LiveFilters } from "./liveReplayModel";

interface Props {
  filters: LiveFilters;
  filtersOpen: boolean;
  activeFilterCount: number;
  gameTypes: string[];
  featuredMods: string[];
  activePlayerOptions: number[];
  maxPlayerOptions: number[];
  onFilter: <K extends keyof LiveFilters>(key: K, value: LiveFilters[K]) => void;
  onToggleFilters: () => void;
  onClear: () => void;
}

export function LiveReplayControls(props: Props) {
  const { filters, onFilter } = props;
  return (
    <>
      <div className="live-replay-toolbar">
        <label className="search-field live-replay-search">
          <Icon name="search" size={15} />
          <input
            value={filters.search}
            onChange={(event) => onFilter("search", event.target.value)}
            placeholder="Search games, maps, hosts, or players"
            aria-label="Search live replays"
          />
        </label>
        <Button
          className={props.filtersOpen ? "live-filter-button active" : "live-filter-button"}
          aria-expanded={props.filtersOpen}
          onClick={props.onToggleFilters}
        >
          <Icon name="filter" size={15} />
          Filters{props.activeFilterCount > 0 ? ` (${props.activeFilterCount})` : ""}
        </Button>
        {props.activeFilterCount > 0 && <Button onClick={props.onClear}>Clear</Button>}
        <span className="live-replay-stream-status">
          <i aria-hidden="true" /> Live updates
        </span>
      </div>

      {props.filtersOpen && (
        <div className="live-replay-filters surface-panel">
          <label>
            <span>Game type</span>
            <select value={filters.gameType} onChange={(event) => onFilter("gameType", event.target.value)}>
              <option value="">Any type</option>
              {props.gameTypes.map((type) => <option key={type} value={type}>{prettyGameType(type)}</option>)}
            </select>
          </label>
          <label>
            <span>Featured mod</span>
            <select value={filters.featuredMod} onChange={(event) => onFilter("featuredMod", event.target.value)}>
              <option value="">Any mod</option>
              {props.featuredMods.map((mod) => <option key={mod} value={mod}>{mod}</option>)}
            </select>
          </label>
          <label>
            <span>Active players</span>
            <select value={filters.activePlayers} onChange={(event) => onFilter("activePlayers", event.target.value)}>
              <option value="">Any count</option>
              {props.activePlayerOptions.map((count) => <option key={count} value={count}>{count}</option>)}
            </select>
          </label>
          <label>
            <span>Game size</span>
            <select value={filters.maxPlayers} onChange={(event) => onFilter("maxPlayers", event.target.value)}>
              <option value="">Any size</option>
              {props.maxPlayerOptions.map((count) => <option key={count} value={count}>{count} slots</option>)}
            </select>
          </label>
          <label className="option-check">
            <input type="checkbox" checked={filters.hideModded} onChange={(event) => onFilter("hideModded", event.target.checked)} />
            Hide SIM-modded games
          </label>
          <label className="option-check">
            <input type="checkbox" checked={filters.hideSinglePlayer} onChange={(event) => onFilter("hideSinglePlayer", event.target.checked)} />
            Hide single-player games
          </label>
          <label className="option-check">
            <input type="checkbox" checked={filters.friendsOnly} onChange={(event) => onFilter("friendsOnly", event.target.checked)} />
            Games with friends
          </label>
        </div>
      )}
    </>
  );
}
