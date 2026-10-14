// The installed library's summary row, over the grid's column only, the way
// the leaderboard has one over its table: what the filters left and how many
// of them the next game loads, then at the list's top right what is done to
// the library as a whole: look for updates, read the folder again, the order,
// and switching the starred mods on, last because it is the one that changes
// a game.

import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { InstalledMod, ModListStatus } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import type { InstalledModFilters, InstalledModSort } from "./useInstalledModFilters";
import type { ModUpdateCheck } from "./useModUpdateCheck";

export function InstalledModSummary({
  installed,
  filters,
  updateCheck,
  busy,
  installedStatus,
  vaultStatus,
  favoriteCount,
  favoritesToEnable,
  onEnableFavorites,
  onRescan,
}: {
  installed: InstalledMod[];
  filters: InstalledModFilters;
  updateCheck: ModUpdateCheck;
  busy: boolean;
  installedStatus: ModListStatus;
  vaultStatus: ModListStatus;
  /** The starred mods that are installed. */
  favoriteCount: number;
  /** The starred mods that are installed and off. */
  favoritesToEnable: InstalledMod[];
  onEnableFavorites: () => void;
  onRescan: () => void;
}) {
  const { t } = useTranslation();
  const { filtered, sort, setSort } = filters;
  const { checking, checkResult, startCheck } = updateCheck;

  return (
    <div className="mods-summary installed-mod-summary">
      <div className="mods-summary-count">
        <Icon name="folder" size={16} />
        <strong>{t("mods.installed.installedCount", { count: filtered.length })}</strong>
        <span className="muted">
          {t("mods.installed.activeCount", { count: installed.filter((mod) => mod.enabled).length })}
        </span>
      </div>
      <span className="spacer" />
      {checkResult && (
        <span className="installed-mod-check-result muted" role="status">
          {checkResult}
        </span>
      )}
      <Button
        variant="ghost"
        className="mods-summary-tool"
        disabled={checking || vaultStatus.type === "loading"}
        onClick={startCheck}
      >
        <Icon name="download" size={15} />
        {t(checking ? "mods.installed.checking" : "mods.installed.checkUpdates")}
      </Button>
      <Button
        variant="ghost"
        className="mods-summary-tool"
        onClick={onRescan}
        disabled={installedStatus.type === "loading"}
      >
        <Icon name="refresh" size={15} />
        {t("mods.installed.rescan")}
      </Button>
      <label className="mods-summary-sort">
        <span className="muted">{t("mods.view.sortBy")}</span>
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
      </label>
      {favoriteCount > 0 && (
        <Button
          variant="primary"
          disabled={busy || favoritesToEnable.length === 0}
          title={t(favoritesToEnable.length === 0
            ? "mods.installed.favoritesAllOn"
            : "mods.installed.enableFavoritesHint")}
          onClick={onEnableFavorites}
        >
          <Icon name="star" size={15} fill="currentColor" />
          {t("mods.installed.enableFavorites")}
          {favoritesToEnable.length > 0 ? ` (${favoritesToEnable.length})` : ""}
        </Button>
      )}
    </div>
  );
}
