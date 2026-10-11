import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type { CustomGameSort } from "../../../ipc/bindings";
import type { GameViewMode } from "../../../shared/gameRules";
import { useTranslation } from "../../../i18n/useTranslation";

/**
 * What the list can be ordered by.
 *
 * `CustomGameSort` from the bindings, named locally because the toolbar has
 * always called it this. It is the same set of values, and the column headers
 * in `gameBrowserColumns` set four of them.
 */
export type SortMode = CustomGameSort;

interface Props {
  search: string;
  sort: SortMode;
  viewMode: GameViewMode;
  /**
   * How many filters are hiding games: the hide switches that are on and the
   * rules while they are applied (`activeFilterCount`). The switches live in
   * the filters dialog, so this number on its button is what keeps a filter
   * that is on from going unnoticed.
   */
  filterCount: number;
  connected: boolean;
  onSearch: (value: string) => void;
  onSort: (value: SortMode) => void;
  onViewMode: (value: GameViewMode) => void;
  onOpenFilters: () => void;
  onHost: () => void;
  onRefresh?: () => void;
  /** Whether the details panel beside the list is folded away. */
  detailHidden?: boolean;
  /** Folds the details panel away or brings it back. */
  onToggleDetails?: () => void;
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
      {/* The hide switches and "Apply filters" are in the dialog this opens.
          Five checkboxes beside the search took the toolbar to two rows at
          the default 1100 pixel window, pushing every game down a row's
          height; the count on the button is what still shows they are on. */}
      <Button onClick={props.onOpenFilters}>
        <Icon name="filter" size={15} />
        {t("lobby.toolbar.filters")}
        {props.filterCount > 0 ? ` (${props.filterCount})` : ""}
      </Button>
      <select
        className="play-sort"
        value={props.sort}
        onChange={(event) => props.onSort(event.target.value as SortMode)}
        aria-label={t("lobby.toolbar.sortAria")}
      >
        <option value="title">{t("lobby.browser.column.game")}</option>
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
      {/* The details panel's fold, beside the view switch: the other choice
          about how this list is laid out. It used to be a tab hanging in the
          gap between the list and the panel, which touched the list and
          looked stranded once the panel was folded away. */}
      {props.onToggleDetails && (
        <Button
          className="play-detail-toggle"
          aria-pressed={!props.detailHidden}
          aria-label={t(props.detailHidden ? "lobby.browser.showDetails" : "lobby.browser.hideDetails")}
          title={t(props.detailHidden ? "lobby.browser.showDetails" : "lobby.browser.hideDetails")}
          onClick={props.onToggleDetails}
        >
          <Icon name="panelRight" size={15} />
        </Button>
      )}
    </div>
  );
}
