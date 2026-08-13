import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { GameViewMode } from "./CustomGamesBrowser";

export type SortMode = "players" | "rating" | "map" | "host" | "age";

interface Props {
  search: string;
  sort: SortMode;
  viewMode: GameViewMode;
  hidePrivate: boolean;
  hideModded: boolean;
  applyFilters: boolean;
  filterCount: number;
  connected: boolean;
  onSearch: (value: string) => void;
  onSort: (value: SortMode) => void;
  onViewMode: (value: GameViewMode) => void;
  onHidePrivate: (value: boolean) => void;
  onHideModded: (value: boolean) => void;
  onApplyFilters: (value: boolean) => void;
  onOpenFilters: () => void;
  onHost: () => void;
}

export function CustomGamesToolbar(props: Props) {
  return (
    <div className="play-toolbar">
      <label className="search-field">
        <Icon name="search" size={15} />
        <input
          value={props.search}
          onChange={(event) => props.onSearch(event.target.value)}
          placeholder="Search games, maps, or hosts"
          aria-label="Search custom games"
        />
      </label>
      <label className="toolbar-check">
        <input
          type="checkbox"
          checked={props.hidePrivate}
          onChange={(event) => props.onHidePrivate(event.target.checked)}
        />
        Hide private
      </label>
      <label className="toolbar-check">
        <input
          type="checkbox"
          checked={props.hideModded}
          onChange={(event) => props.onHideModded(event.target.checked)}
        />
        Hide modded
      </label>
      <label className="toolbar-check">
        <input
          type="checkbox"
          checked={props.applyFilters}
          onChange={(event) => props.onApplyFilters(event.target.checked)}
        />
        Apply filters
      </label>
      <Button onClick={props.onOpenFilters}>
        <Icon name="filter" size={15} />
        Filters{props.filterCount > 0 ? ` (${props.filterCount})` : ""}
      </Button>
      <select
        className="play-sort"
        value={props.sort}
        onChange={(event) => props.onSort(event.target.value as SortMode)}
        aria-label="Sort games"
      >
        <option value="players">Sort by players</option>
        <option value="rating">Sort by rating</option>
        <option value="map">Sort by map</option>
        <option value="host">Sort by host</option>
        <option value="age">Sort by age</option>
      </select>
      <div className="game-view-switch surface" role="group" aria-label="Game view">
        <button
          className={props.viewMode === "tiles" ? "active" : ""}
          aria-pressed={props.viewMode === "tiles"}
          aria-label="Tile view"
          title="Tile view"
          onClick={() => props.onViewMode("tiles")}
        >
          <Icon name="grid" size={15} />
        </button>
        <button
          className={props.viewMode === "list" ? "active" : ""}
          aria-pressed={props.viewMode === "list"}
          aria-label="List view"
          title="List view"
          onClick={() => props.onViewMode("list")}
        >
          <Icon name="list" size={15} />
        </button>
      </div>
      <Button variant="primary" disabled={!props.connected} onClick={props.onHost}>
        <Icon name="plus" size={16} /> Host game
      </Button>
    </div>
  );
}
