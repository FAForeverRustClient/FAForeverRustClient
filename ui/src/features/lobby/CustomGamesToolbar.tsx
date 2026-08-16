import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { GameViewMode } from "./CustomGamesBrowser";
import { useTranslation } from "../../i18n/useTranslation";

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
  onRefresh?: () => void;
}

export function CustomGamesToolbar(props: Props) {
  const { t } = useTranslation();
  return (
    <div className="play-toolbar">
      <Button variant="primary" disabled={!props.connected} onClick={props.onHost}>
        <Icon name="plus" size={16} /> {t("lobby.toolbar.hostGame")}
      </Button>
      <label className="search-field">
        <Icon name="search" size={15} />
        <input
          value={props.search}
          onChange={(event) => props.onSearch(event.target.value)}
          placeholder={t("lobby.toolbar.searchPlaceholder")}
          aria-label={t("lobby.toolbar.searchAria")}
        />
      </label>
      <label className="toolbar-check">
        <input
          type="checkbox"
          checked={props.hidePrivate}
          onChange={(event) => props.onHidePrivate(event.target.checked)}
        />
        {t("lobby.toolbar.hidePrivate")}
      </label>
      <label className="toolbar-check">
        <input
          type="checkbox"
          checked={props.hideModded}
          onChange={(event) => props.onHideModded(event.target.checked)}
        />
        {t("lobby.toolbar.hideModded")}
      </label>
      <label className="toolbar-check">
        <input
          type="checkbox"
          checked={props.applyFilters}
          onChange={(event) => props.onApplyFilters(event.target.checked)}
        />
        {t("lobby.toolbar.applyFilters")}
      </label>
      <Button onClick={props.onOpenFilters}>
        <Icon name="filter" size={15} />
        Filters{props.filterCount > 0 ? ` (${props.filterCount})` : ""}
      </Button>
      <select
        className="play-sort"
        value={props.sort}
        onChange={(event) => props.onSort(event.target.value as SortMode)}
        aria-label={t("lobby.toolbar.sortAria")}
      >
        <option value="players">{t("lobby.toolbar.sort.players")}</option>
        <option value="rating">{t("lobby.toolbar.sort.rating")}</option>
        <option value="map">{t("lobby.toolbar.sort.map")}</option>
        <option value="host">{t("lobby.toolbar.sort.host")}</option>
        <option value="age">{t("lobby.toolbar.sort.age")}</option>
      </select>
      <div className="game-view-switch surface" role="group" aria-label={t("lobby.toolbar.viewAria")}>
        <button
          className={props.viewMode === "tiles" ? "active" : ""}
          aria-pressed={props.viewMode === "tiles"}
          aria-label={t("lobby.toolbar.tileView")}
          title={t("lobby.toolbar.tileView")}
          onClick={() => props.onViewMode("tiles")}
        >
          <Icon name="grid" size={15} />
        </button>
        <button
          className={props.viewMode === "list" ? "active" : ""}
          aria-pressed={props.viewMode === "list"}
          aria-label={t("lobby.toolbar.listView")}
          title={t("lobby.toolbar.listView")}
          onClick={() => props.onViewMode("list")}
        >
          <Icon name="list" size={15} />
        </button>
      </div>
      {props.onRefresh && (
        <Button onClick={props.onRefresh} title={t("lobby.coop.refresh")}>
          <Icon name="refresh" size={15} />
        </Button>
      )}
    </div>
  );
}
