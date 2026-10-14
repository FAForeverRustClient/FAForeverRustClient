// The installed library's search panel: the preset chips and the library's
// actions along the top, and the search fields under them. The filters are
// `useInstalledModFilters`' and the update check `useModUpdateCheck`'s; this
// only draws them, and whether the extra fields are unfolded.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { RangeSlider } from "../../design-system/RangeSlider";
import {
  SearchField,
  SearchPanel,
  SearchPanelToggle,
} from "../../design-system/SearchPanel";
import type { InstalledMod, ModListStatus } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import type {
  EnabledFilter,
  InstalledModFilters,
  InstalledModPreset,
  InstalledModSort,
  ModTypeFilter,
  RankedFilter,
} from "./useInstalledModFilters";
import type { ModUpdateCheck } from "./useModUpdateCheck";

export function InstalledModSearchPanel({
  filters,
  updateCheck,
  busy,
  installedStatus,
  vaultStatus,
  favoriteCount,
  favoritesToEnable,
  updatesCount,
  onEnableFavorites,
  onRescan,
}: {
  filters: InstalledModFilters;
  updateCheck: ModUpdateCheck;
  busy: boolean;
  installedStatus: ModListStatus;
  vaultStatus: ModListStatus;
  /** The starred mods that are installed. */
  favoriteCount: number;
  /** The starred mods that are installed and off. */
  favoritesToEnable: InstalledMod[];
  updatesCount: number;
  onEnableFavorites: () => void;
  onRescan: () => void;
}) {
  const { t } = useTranslation();
  const {
    search, setSearch, creator, setCreator, preset, choosePreset, modType, setModType, enabled, setEnabled,
    ranked, setRanked, minimumRating, setMinimumRating, maximumRating, setMaximumRating, sort, setSort,
    clearSearch, hiddenFilterCount,
  } = filters;
  const { checking, checkResult, startCheck } = updateCheck;
  const [filtersOpen, setFiltersOpen] = useState(false);

  return (
    <SearchPanel
      className="installed-mod-search-panel"
      onSubmit={(event) => event.preventDefault()}
      secondary={(
        <>
          {([
            ["all", t("mods.view.preset.all")],
            ...(favoriteCount > 0
              ? [["favorites", `${t("mods.view.preset.favorites")} (${favoriteCount})`]]
              : []),
            ["enabled", t("mods.installed.enabled")],
            ["disabled", t("mods.installed.disabled")],
            ["ui", t("mods.installed.uiMods")],
            ["sim", t("mods.installed.simMods")],
            ...(updatesCount > 0
              ? [["updates", `${t("mods.view.updatesAvailable")} (${updatesCount})`]]
              : []),
          ] as Array<[InstalledModPreset, string]>).map(([key, label]) => (
            <Button
              key={key}
              className={`installed-mod-preset-${key}${preset === key ? " active" : ""}`}
              onClick={() => choosePreset(key)}
            >
              {label}
            </Button>
          ))}
          <span className="spacer" />
          <SearchPanelToggle
            expanded={filtersOpen}
            count={hiddenFilterCount}
            onClick={() => setFiltersOpen((open) => !open)}
          />
          <Button onClick={clearSearch}>{t("mods.view.clear")}</Button>
          {favoriteCount > 0 && (
            <Button
              variant="primary"
              disabled={busy || favoritesToEnable.length === 0}
              title={t(favoritesToEnable.length === 0
                ? "mods.installed.favoritesAllOn"
                : "mods.installed.enableFavoritesHint")}
              onClick={onEnableFavorites}
            >
              <Icon name="star" size={15} fill="currentColor" />{" "}
              {t("mods.installed.enableFavorites")}
              {favoritesToEnable.length > 0 ? ` (${favoritesToEnable.length})` : ""}
            </Button>
          )}
          <Button onClick={onRescan} disabled={installedStatus.type === "loading"}>
            <Icon name="refresh" size={15} /> {t("mods.installed.rescan")}
          </Button>
          <Button
            disabled={checking || vaultStatus.type === "loading"}
            onClick={startCheck}
          >
            <Icon name="download" size={15} />{" "}
            {t(checking ? "mods.installed.checking" : "mods.installed.checkUpdates")}
          </Button>
          {checkResult && (
            <span className="installed-mod-check-result muted" role="status">
              {checkResult}
            </span>
          )}
        </>
      )}
    >
      <SearchField label={t("mods.view.mod")} className="search-panel-field-grow">
        <input
          className="search-panel-control"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("mods.installed.searchInstalledMods")}
        />
      </SearchField>
      <SearchField label={t("mods.view.creator")} className="search-panel-field-grow">
        <input
          className="search-panel-control"
          value={creator}
          onChange={(event) => setCreator(event.target.value)}
          placeholder={t("mods.view.anyCreatorUploader")}
        />
      </SearchField>
      <RangeSlider
        label={t("mods.view.reviewScore")}
        min={0}
        max={5}
        step={0.5}
        low={minimumRating}
        high={maximumRating}
        format={(value) => `${value}★`}
        onChange={(low, high) => {
          setMinimumRating(low);
          setMaximumRating(high);
        }}
      />
      <SearchField label={t("mods.view.type")} className="search-panel-field-compact">
        <select
          className="search-panel-control"
          value={modType}
          onChange={(event) => setModType(event.target.value as ModTypeFilter)}
        >
          <option value="all">{t("mods.installed.allTypes")}</option>
          <option value="ui">{t("mods.installed.uiMods")}</option>
          <option value="sim">{t("mods.installed.simMods")}</option>
        </select>
      </SearchField>
      <SearchField label={t("mods.installed.stateLabel")} className="search-panel-field-compact">
        <select
          className="search-panel-control"
          value={enabled}
          onChange={(event) => setEnabled(event.target.value as EnabledFilter)}
        >
          <option value="all">{t("mods.installed.anyState")}</option>
          <option value="enabled">{t("mods.installed.enabled")}</option>
          <option value="disabled">{t("mods.installed.disabled")}</option>
        </select>
      </SearchField>
      <SearchField label={t("mods.view.ranking")} className="search-panel-field-compact">
        <select
          className="search-panel-control"
          value={ranked}
          onChange={(event) => setRanked(event.target.value as RankedFilter)}
        >
          <option value="all">{t("mods.view.any")}</option>
          <option value="ranked">{t("mods.view.rankedSafe")}</option>
          <option value="unranked">{t("mods.view.unranked")}</option>
        </select>
      </SearchField>
      <SearchField label={t("maps.view.sortBy")} className="search-panel-field-compact">
        <select
          className="search-panel-control"
          value={sort}
          onChange={(event) => setSort(event.target.value as InstalledModSort)}
        >
          <option value="state">{t("mods.installed.sort.state")}</option>
          <option value="name">{t("maps.view.sort.name")}</option>
          <option value="rating">{t("mods.view.preset.rating")}</option>
          <option value="newest">{t("mods.view.preset.newest")}</option>
          <option value="author">{t("mods.view.creator")}</option>
        </select>
      </SearchField>
    </SearchPanel>
  );
}
