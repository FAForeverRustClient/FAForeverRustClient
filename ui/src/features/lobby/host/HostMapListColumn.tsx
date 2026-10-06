// The host dialog's map column: favourites tab, search, the filter popover,
// the list itself and the random and generate actions. State and behaviour
// come from `useHostMapPicker`; this only draws them.

import { memo } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { RangeSlider } from "../../../design-system/RangeSlider";
import { kilometres } from "../../../shared/mapPresentation";
import { useTranslation } from "../../../i18n/useTranslation";
import {
  formatMapMeta,
  MAX_MAP_KM,
  MAX_MAP_PLAYERS,
  NO_RANGE,
  type RankedFilter,
} from "./hostMapCatalogue";
import type { HostMapPicker } from "./useHostMapPicker";

/**
 * Memoised on a memoised picker: this is the column with every installed map
 * in it, and the dialog around it redraws on each keystroke in the title.
 */
export const HostMapListColumn = memo(function HostMapListColumn({
  picker,
  onGenerate,
}: {
  picker: HostMapPicker;
  onGenerate: () => void;
}) {
  const { t } = useTranslation();
  const {
    filters, filter, toggleFilters, filterRef, mapListRef, availableMaps, visibleMaps, favoriteFolders,
    isFavorite, toggleFavorite, chosen, selectMap, activeFilterCount, chooseRandom, onMapListKeyDown,
  } = picker;
  const { mapSearch, rankedFilter, widthKm, heightKm, playerCount, filtersOpen, mapTab } = filters;

  return (
    <section className="host-column host-column-maps surface-panel">
      <div className="host-column-header">
        <h3>{t("lobby.host.map")}</h3>
        <span className="host-count-badge">
          {t("lobby.host.mapCount", { count: visibleMaps.length })}
        </span>
      </div>

      {/* Two tabs rather than one long list. The thread that asked for this
          started from wanting generated maps grouped, and landed on
          favourites instead: nobody browses every mapgen map, but everybody
          has five maps they host on. */}
      <div className="host-map-tabs section-tabs" role="tablist" aria-label={t("lobby.host.map")}>
        <button
          type="button"
          role="tab"
          aria-selected={mapTab === "all"}
          className={mapTab === "all" ? "active" : ""}
          onClick={() => filter({ mapTab: "all" })}
        >
          {t("lobby.host.mapTab.all", { count: availableMaps.length })}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mapTab === "favorites"}
          className={mapTab === "favorites" ? "active" : ""}
          onClick={() => filter({ mapTab: "favorites" })}
        >
          {t("lobby.host.mapTab.favorites", { count: favoriteFolders.size })}
        </button>
      </div>

      <div className="host-map-search-row">
        <div className="search-field host-column-search host-map-search-field">
          <Icon name="search" size={13} />
          <input
            value={mapSearch}
            onChange={(event) => filter({ mapSearch: event.target.value })}
            placeholder={t("lobby.host.searchMapsPlaceholder")}
            aria-label={t("lobby.host.searchMapsAria")}
          />
        </div>
        <div className="host-map-filter" ref={filterRef}>
          <button
            type="button"
            className={`host-map-filter-button${activeFilterCount > 0 ? " active" : ""}`}
            aria-expanded={filtersOpen}
            onClick={toggleFilters}
          >
            <Icon name="filter" size={13} />
            {t("lobby.host.filter")}
            {activeFilterCount > 0 && (
              <span className="host-map-filter-count">{activeFilterCount}</span>
            )}
          </button>

          {/* A popover rather than a dialog: it filters the list behind it,
              and that list has to stay visible while the sliders move. */}
          {filtersOpen && (
            <div className="host-map-filter-popover surface-panel" role="group">
              <RangeSlider
                label={t("lobby.host.filterWidth")}
                min={0}
                max={MAX_MAP_KM}
                low={widthKm.low}
                high={widthKm.high}
                format={kilometres}
                onChange={(low, high) => filter({ widthKm: { low, high } })}
              />
              <RangeSlider
                label={t("lobby.host.filterHeight")}
                min={0}
                max={MAX_MAP_KM}
                low={heightKm.low}
                high={heightKm.high}
                format={kilometres}
                onChange={(low, high) => filter({ heightKm: { low, high } })}
              />
              <RangeSlider
                label={t("lobby.host.filterPlayers")}
                min={0}
                max={MAX_MAP_PLAYERS}
                low={playerCount.low}
                high={playerCount.high}
                onChange={(low, high) => filter({ playerCount: { low, high } })}
              />
              <div className="host-map-filter-choice">
                <span className="host-map-filter-choice-label">
                  {t("lobby.host.filterRanked")}
                </span>
                <div
                  className="settings-segmented surface"
                  role="group"
                  aria-label={t("lobby.host.filterRanked")}
                >
                  {(["all", "ranked", "unranked"] as RankedFilter[]).map((value) => (
                    <button
                      type="button"
                      key={value}
                      className={rankedFilter === value ? "is-active" : ""}
                      aria-pressed={rankedFilter === value}
                      onClick={() => filter({ rankedFilter: value })}
                    >
                      {t(
                        value === "all"
                          ? "lobby.host.filterRankedAll"
                          : value === "ranked"
                            ? "lobby.host.filterRankedOnly"
                            : "lobby.host.filterUnrankedOnly",
                      )}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                className="host-map-filter-reset"
                disabled={activeFilterCount === 0}
                onClick={() => {
                  filter({ widthKm: NO_RANGE, heightKm: NO_RANGE, playerCount: NO_RANGE, rankedFilter: "all" });
                }}
              >
                {t("lobby.host.filterReset")}
              </button>
            </div>
          )}
        </div>
      </div>

      <div
        ref={mapListRef}
        className="host-column-body host-map-list"
        role="listbox"
        aria-label={t("lobby.host.availableMaps")}
        onKeyDown={onMapListKeyDown}
      >
        {visibleMaps.length === 0 ? (
          <p className="play-empty">
            {t(mapTab === "favorites" ? "lobby.host.noFavoriteMaps" : "lobby.host.noMaps")}
          </p>
        ) : (
          visibleMaps.map((map) => {
            const starred = isFavorite(map.folderName);
            return (
              // A wrapper, because the star is a second action on the row
              // and a button inside a button is neither valid nor
              // clickable. `presentation` keeps the listbox owning its
              // options across it.
              <div className="host-map-row-wrap" key={map.folderName} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={chosen?.folderName === map.folderName}
                  className={`host-map-row${chosen?.folderName === map.folderName ? " active" : ""}`}
                  onClick={() => selectMap(map.folderName)}
                >
                  <span className="host-map-name" title={map.displayName}>
                    {map.displayName}
                  </span>
                  <span className="host-map-meta">
                    {formatMapMeta(map) || t("lobby.host.playersUnstated")}
                  </span>
                </button>
                <button
                  type="button"
                  className={starred ? "host-map-favorite is-on" : "host-map-favorite"}
                  aria-pressed={starred}
                  title={t(starred ? "lobby.host.unfavorite" : "lobby.host.favorite", { name: map.displayName })}
                  aria-label={t(starred ? "lobby.host.unfavorite" : "lobby.host.favorite", { name: map.displayName })}
                  onClick={() => toggleFavorite(map.folderName)}
                >
                  <Icon name="star" size={13} />
                </button>
              </div>
            );
          })
        )}
      </div>

      <div className="host-column-footer host-map-actions">
        <Button className="host-col-action-btn" onClick={chooseRandom} title={t("lobby.host.randomTitle")}>
          <Icon name="refresh" size={14} />
          {t("lobby.host.randomMap")}
        </Button>
        <Button
          className="host-col-action-btn host-generate-btn"
          onClick={onGenerate}
          title={t("lobby.host.generateTitle")}
        >
          <span className="host-generate-btn-label">
            <Icon name="plus" size={14} />
            <span>{t("lobby.host.generateMap")}</span>
          </span>
          <span className="host-badge-neroxis">Neroxis</span>
        </Button>
      </div>
    </section>
  );
});
