// Mods tab: vault discovery plus installed/active-mod management. Rust owns
// the catalogue and filesystem/game.prefs state; this view derives only the
// current search, filters, sorting and selection.

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { SectionTabs } from "../../design-system/SectionTabs";
import { Icon } from "../../design-system/Icon";
import { EmptyState } from "../../design-system/EmptyState";
import { RangeSlider } from "../../design-system/RangeSlider";
import {
  SearchField,
  SearchPanel,
  SearchPanelSubmit,
  SearchPanelToggle,
} from "../../design-system/SearchPanel";
import { Pagination } from "../../design-system/Pagination";
import type { InstalledMod, ModVaultQuery } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { EMPTY_MOD_QUERY } from "../../shared/vaultQuery";
import { loadStatusNote } from "../../shared/loadStatusNote";
import { useAppStore } from "../../store/store";
import {
  ModCard,
  ModDetailPanel,
  UninstallDialog,
} from "./ModVaultComponents";
import { InstalledModsView } from "./InstalledModsView";
// Two entry points, not two implementations of one: the modal publishes a mod
// that is already installed, and `openUploadFromDisk` takes an archive straight
// off the filesystem, which is what an author has after building one.
import { openUploadFromDisk } from "../uploads/UploadDialog";
import { ModUploadModal } from "./ModUploadModal";
import "./mods.css";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n";

type SubView = "vault" | "installed";
type ModSort = "rating" | "newest" | "updated" | "name";
type ModTypeFilter = "all" | "ui" | "sim";
type RankedFilter = "all" | "ranked" | "unranked";
type InstallFilter = "all" | "installed" | "available" | "updates";
type ModPreset = "recommended" | "favorites" | "mine" | "rating" | "ui" | "newest" | "all";
type DateField = "updated" | "uploaded";

const PAGE_SIZE = 36;
const MOD_PRESETS: Array<[ModPreset, MessageKey]> = [
  ["recommended", "mods.view.preset.recommended"],
  ["favorites", "mods.view.preset.favorites"],
  // Only once there is an id to filter on: see `modVaultQuery`.
  ["mine", "mods.view.preset.mine"],
  ["rating", "mods.view.preset.rating"],
  ["ui", "mods.view.preset.ui"],
  ["newest", "mods.view.preset.newest"],
  ["all", "mods.view.preset.all"],
];

const loadVault = () => ipc.send({ kind: "Mods", command: { type: "loadVault" } });
const loadInstalled = () => ipc.send({ kind: "Mods", command: { type: "loadInstalled" } });
const installMod = (uid: string, downloadUrl: string) => ipc.send({ kind: "Mods", command: { type: "installMod", payload: { uid, downloadUrl } } });
const uninstallMod = (folderName: string, uid: string) => ipc.send({ kind: "Mods", command: { type: "uninstallMod", payload: { folderName, uid } } });
const toggleMod = (uid: string, enabled: boolean) => ipc.send({ kind: "Mods", command: { type: "toggleMod", payload: { uid, enabled } } });

interface ModFilterState {
  search: string;
  creator: string;
  sort: ModSort;
  modType: ModTypeFilter;
  ranked: RankedFilter;
  installFilter: InstallFilter;
  dateField: DateField;
  dateAfter: string;
  dateBefore: string;
  minimumRating: number | null;
  maximumRating: number | null;
}

/**
 * The tab.s filter state as the API query it stands for. See `MapsView`.
 */
function modVaultQuery(
  applied: ModFilterState,
  preset: ModPreset,
  page: number,
  playerId: number | null,
): ModVaultQuery {
  const sortBy: ModVaultQuery["sortBy"] = applied.sort === "newest" ? "newest"
    : applied.sort === "updated" ? "updated"
      : applied.sort === "name" ? "name"
        : "rating";
  // The `ui` preset is a type filter, not a sort.
  const modType = preset === "ui" ? "ui" : applied.modType === "all" ? "" : applied.modType;
  return {
    ...EMPTY_MOD_QUERY,
    search: applied.search.trim(),
    author: applied.creator.trim(),
    // The uploader, not the declared author: see `ModVaultQuery::uploader_id`.
    // Unlike the map vault this asks for no hidden versions, because nothing
    // here could put one back (`ModVersion.hidden` is an administrator's field
    // alone), so listing them would only be a dead end.
    uploaderId: preset === "mine" && playerId !== null ? playerId : null,
    modType,
    ranked: applied.ranked === "all" ? null : applied.ranked === "ranked",
    recommended: preset === "recommended",
    minRatingTenths: applied.minimumRating === null ? null : Math.round(applied.minimumRating * 10),
    maxRatingTenths: applied.maximumRating === null ? null : Math.round(applied.maximumRating * 10),
    dateFieldUpdated: applied.dateField === "updated",
    after: applied.dateAfter,
    before: applied.dateBefore,
    sortBy,
    sortDescending: sortBy !== "name",
    page,
    pageSize: PAGE_SIZE,
  };
}

function VaultView({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.mods.vault);
  const vaultStatus = useAppStore((state) => state.state.mods.vaultStatus);
  const browse = useAppStore((state) => state.state.mods.browse);
  const browseStatus = useAppStore((state) => state.state.mods.browseStatus);
  const browseTotalPages = useAppStore((state) => state.state.mods.browseTotalPages);
  const installed = useAppStore((state) => state.state.mods.installed);
  const installedStatus = useAppStore((state) => state.state.mods.installedStatus);
  const installStatus = useAppStore((state) => state.state.mods.installStatus);
  const toggleStatus = useAppStore((state) => state.state.mods.toggleStatus);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  // Who "my mods" is about. Null until login, which is why the preset is not
  // offered before then: without an id the query would silently widen to the
  // whole vault.
  const playerId = useAppStore((state) => state.state.auth.player?.id ?? null);
  const storedPreset = (browsing.modVaultPreset as ModPreset) || "recommended";
  const preset: ModPreset = storedPreset === "mine" && playerId === null ? "recommended" : storedPreset;
  const initialSort: ModSort = (() => {
    if (preset === "newest" || preset === "mine") return "newest";
    if (preset === "all") return "name";
    return "rating";
  })();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ModSort>(initialSort);
  const [modType, setModType] = useState<ModTypeFilter>("all");
  const [ranked, setRanked] = useState<RankedFilter>("all");
  const [installFilter, setInstallFilter] = useState<InstallFilter>("all");
  const [creator, setCreator] = useState("");
  const [dateField, setDateField] = useState<DateField>("updated");
  const [dateAfter, setDateAfter] = useState("");
  const [dateBefore, setDateBefore] = useState("");
  const [minimumRating, setMinimumRating] = useState<number | null>(null);
  const [maximumRating, setMaximumRating] = useState<number | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledMod | null>(null);

  const [applied, setApplied] = useState<ModFilterState>({
    search: "",
    creator: "",
    sort: initialSort,
    modType: "all",
    ranked: "all",
    installFilter: "all",
    dateField: "updated",
    dateAfter: "",
    dateBefore: "",
    minimumRating: null,
    maximumRating: null,
  });

  const note = loadStatusNote(vaultStatus, t("mods.view.loadingVault"), t("mods.view.vaultFailed"));
  const installedByUid = useMemo(() => new Map(installed.map((mod) => [mod.uid, mod])), [installed]);
  const favoriteUids = useMemo(
    () => new Set((browsing.favoriteMods || []).map((uid) => uid.toLocaleLowerCase())),
    [browsing.favoriteMods],
  );

  const toggleFavorite = (uid: string) => {
    const key = uid.trim().toLocaleLowerCase();
    const favoriteMods = favoriteUids.has(key)
      ? (browsing.favoriteMods || []).filter((favorite) => favorite.toLocaleLowerCase() !== key)
      : [...(browsing.favoriteMods || []), key];
    ipc.send({
      kind: "Settings",
      command: { type: "setBrowsing", payload: { preferences: { ...browsing, favoriteMods } } },
    });
  };

  useEffect(() => {
    const mods = useAppStore.getState().state.mods;
    if (mods.vaultStatus.type === "idle") loadVault();
    if (mods.installedStatus.type === "idle") loadInstalled();
  }, []);

  useEffect(() => {
    // "My mods" has no ranking of its own worth defaulting to, and newest
    // first is what an uploader wants: the release they just pushed.
    if (preset === "newest" || preset === "mine") {
      setSort("newest");
      setApplied((prev) => ({ ...prev, sort: "newest" }));
    } else if (preset === "all") {
      setSort("name");
      setApplied((prev) => ({ ...prev, sort: "name" }));
    } else if (preset === "recommended" || preset === "rating" || preset === "ui" || preset === "favorites") {
      setSort("rating");
      setApplied((prev) => ({ ...prev, sort: "rating" }));
    }
  }, [preset]);

  const applySearch = () => {
    setApplied({
      search,
      creator,
      sort,
      modType,
      ranked,
      installFilter,
      dateField,
      dateAfter,
      dateBefore,
      minimumRating,
      maximumRating,
    });
    setPage(1);
  };

  // Sorting is not a preset. Routed through `choosePreset("all")` it forced the
  // sort back to "name" and dropped the preset's own filter, so every choice
  // but "Name" looked like it did nothing. See the twin in MapsView.
  const chooseSort = (nextSort: ModSort) => {
    setSort(nextSort);
    setApplied((prev) => ({ ...prev, sort: nextSort }));
    setPage(1);
  };

  const choosePreset = (next: ModPreset) => {
    let nextSort: ModSort = sort;
    if (next === "recommended" || next === "rating" || next === "ui" || next === "favorites") nextSort = "rating";
    if (next === "newest" || next === "mine") nextSort = "newest";
    if (next === "all") nextSort = "name";
    setSort(nextSort);
    setApplied((prev) => ({ ...prev, sort: nextSort }));
    setPage(1);
    if (browsing.modVaultPreset !== next) {
      ipc.send({
        kind: "Settings",
        command: { type: "setBrowsing", payload: { preferences: { ...browsing, modVaultPreset: next } } },
      });
    }
  };

  const clearSearch = () => {
    setSearch("");
    setCreator("");
    setModType("all");
    setRanked("all");
    setInstallFilter("all");
    setDateField("updated");
    setDateAfter("");
    setDateBefore("");
    setMinimumRating(null);
    setMaximumRating(null);
    setApplied({
      search: "",
      creator: "",
      sort: "rating",
      modType: "all",
      ranked: "all",
      installFilter: "all",
      dateField: "updated",
      dateAfter: "",
      dateBefore: "",
      minimumRating: null,
      maximumRating: null,
    });
    setPage(1);
    choosePreset("recommended");
  };

  // `favorites` is local state the server has never heard of. It filters the
  // index loaded in memory rather than asking the server.
  const localFavorites = preset === "favorites";

  // Server-side search, as in both reference clients: the filters go out as a
  // query and one page comes back.
  const query = useMemo(
    () => modVaultQuery(applied, preset, page, playerId),
    [applied, preset, page, playerId],
  );

  useEffect(() => {
    if (localFavorites) return;
    ipc.send({ kind: "Mods", command: { type: "searchVault", payload: { query } } });
  }, [localFavorites, query]);

  const favorites = useMemo(
    () => (localFavorites
      ? vault.filter((mod) => favoriteUids.has(mod.uid.toLocaleLowerCase()))
      : []),
    [localFavorites, vault, favoriteUids],
  );

  const results = useMemo(() => {
    const source = localFavorites ? favorites : browse;
    if (applied.installFilter === "all") return source;
    return source.filter((mod) => {
      const installedMod = installedByUid.get(mod.uid);
      if (applied.installFilter === "installed") return Boolean(installedMod);
      if (applied.installFilter === "updates") {
        return Boolean(installedMod && installedMod.version !== mod.version);
      }
      return !installedMod;
    });
  }, [applied.installFilter, browse, favorites, installedByUid, localFavorites]);

  const totalPages = localFavorites
    ? Math.max(1, Math.ceil(favorites.length / PAGE_SIZE))
    : browseTotalPages ?? 1;
  const currentPage = Math.min(page, totalPages);
  const pageMods = localFavorites
    ? results.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
    : results;
  const selected = pageMods.find((mod) => mod.uid === selectedUid) ?? pageMods[0] ?? null;
  const hiddenFilterCount = Number(installFilter !== "all")
    + Number(dateAfter !== "" || dateBefore !== "");

  return (
    <>
      <SearchPanel
        className="mod-search-panel"
        onSubmit={(event) => {
          event.preventDefault();
          applySearch();
        }}
        secondary={(
          <>
            {MOD_PRESETS.filter(([key]) => key !== "mine" || playerId !== null).map(([key, label]) => (
              <Button
                key={key}
                className={preset === key ? "active" : ""}
                onClick={() => choosePreset(key)}
                title={
                  key === "favorites"
                    ? t("mods.view.preset.favoritesTitle", { count: favoriteUids.size })
                    : key === "mine"
                      ? t("mods.view.preset.mineTitle")
                      : undefined
                }
              >
                {key === "favorites" && <Icon name="star" size={14} fill="currentColor" />}
                {key === "mine" && <Icon name="mods" size={14} />} {t(label)}
              </Button>
            ))}
            <span className="spacer" />
            <SearchPanelToggle expanded={filtersOpen} count={hiddenFilterCount} onClick={() => setFiltersOpen((open) => !open)} />
            <Button onClick={clearSearch}>{t("mods.view.clear")}</Button>
            <Button
              onClick={() => ipc.send({ kind: "Mods", command: { type: "searchVault", payload: { query } } })}
              disabled={browseStatus.type === "loading"}
            >
              <Icon name="refresh" size={15} /> {t("mods.view.refresh")}
            </Button>
            <Button onClick={() => void openUploadFromDisk("mod")}><Icon name="plus" size={15} /> {t("mods.view.uploadFromDisk")}</Button>
                      </>
        )}
        advanced={filtersOpen ? (
          <div className="search-panel-advanced">
            <div className="search-panel-advanced-grid">
              <SearchField label={t("mods.view.installation")}><select className="search-panel-control" value={installFilter} onChange={(event) => setInstallFilter(event.target.value as InstallFilter)}><option value="all">{t("mods.view.any")}</option><option value="installed">{t("mods.view.installed")}</option><option value="available">{t("mods.view.notInstalled")}</option><option value="updates">{t("mods.view.updatesAvailable")}</option></select></SearchField>
              <SearchField label={t("mods.view.dateField")}><select className="search-panel-control" value={dateField} onChange={(event) => setDateField(event.target.value as DateField)}><option value="updated">{t("mods.view.lastUpdated")}</option><option value="uploaded">{t("mods.view.uploaded")}</option></select></SearchField>
              <SearchField label={t("mods.view.after")}><input className="search-panel-control" type="date" value={dateAfter} onChange={(event) => setDateAfter(event.target.value)} /></SearchField>
              <SearchField label={t("mods.view.before")}><input className="search-panel-control" type="date" value={dateBefore} onChange={(event) => setDateBefore(event.target.value)} /></SearchField>
            </div>
          </div>
        ) : undefined}
      >
        <SearchField label={t("mods.view.mod")} className="search-panel-field-grow">
          <input
            className="search-panel-control"
            value={search}
            onChange={(event) => {
              const value = event.target.value;
              setSearch(value);
              if (value.trim() && preset === "recommended") choosePreset("all");
            }}
            placeholder={t("mods.view.nameDescriptionUid")}
          />
        </SearchField>
        <SearchField label={t("mods.view.creator")} className="search-panel-field-grow">
          <input
            className="search-panel-control"
            value={creator}
            onChange={(event) => {
              const value = event.target.value;
              setCreator(value);
              if (value.trim() && preset === "recommended") choosePreset("all");
            }}
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
          onChange={(low, high) => { setMinimumRating(low); setMaximumRating(high); }}
        />
        <SearchField label={t("mods.view.type")} className="search-panel-field-compact">
          <select className="search-panel-control" value={modType} onChange={(event) => { setModType(event.target.value as ModTypeFilter); choosePreset("all"); }}><option value="all">{t("mods.view.any")}</option><option value="ui">{t("mods.view.uiMods")}</option><option value="sim">{t("mods.view.simMods")}</option></select>
        </SearchField>
        <SearchField label={t("mods.view.ranking")} className="search-panel-field-compact">
          <select className="search-panel-control" value={ranked} onChange={(event) => setRanked(event.target.value as RankedFilter)}><option value="all">{t("mods.view.any")}</option><option value="ranked">{t("mods.view.rankedSafe")}</option><option value="unranked">{t("mods.view.unranked")}</option></select>
        </SearchField>
        <SearchField label={t("mods.view.sortBy")} className="search-panel-field-compact">
          <select className="search-panel-control" value={sort} onChange={(event) => chooseSort(event.target.value as ModSort)}><option value="rating">{t("mods.view.preset.rating")}</option><option value="newest">{t("mods.view.preset.newest")}</option><option value="updated">{t("mods.view.recentlyUpdated")}</option><option value="name">{t("mods.view.name")}</option></select>
        </SearchField>
        <SearchPanelSubmit />
      </SearchPanel>

      {note && <p className="vault-note muted">{note}</p>}
      {installedStatus.type === "failed" && <p className="vault-note muted">{t("mods.view.detectionUnavailable")}</p>}
      {(browseStatus.type === "ready" || localFavorites) && pageMods.length === 0 ? (
        // An empty "my mods" is the ordinary state for most players rather
        // than a failed search, so it says so instead of suggesting the
        // filters be widened.
        preset === "mine" ? (
          <EmptyState
            bordered
            icon="mods"
            title={t("mods.view.emptyMine")}
            hint={t("mods.view.emptyMineHint")}
          />
        ) : (
          <EmptyState
            bordered
            icon={vault.length === 0 ? "mods" : "search"}
            title={t(vault.length === 0 ? "mods.view.emptyVault" : "mods.view.noMatch")}
            hint={t(vault.length === 0 ? "mods.view.emptyVaultHint" : "mods.view.noMatchHint")}
          />
        )
      ) : pageMods.length > 0 ? (
        <>
          <div className="vault-results-head">
            <span>{t("maps.view.resultCount", { count: pageMods.length })}</span>
            <span>{t("maps.view.pageOf", { page: currentPage, total: totalPages })}</span>
          </div>
          <div className="vault-layout">
            <section className="vault-browser">
              <div className="mod-vault-grid">
                {pageMods.map((mod) => {
                  const installedMod = installedByUid.get(mod.uid);
                  const isBusy = busy && (
                    (installStatus.type === "installing" && installStatus.payload.uid === mod.uid)
                    || (toggleStatus.type === "toggling" && toggleStatus.payload.uid === mod.uid)
                  );
                  return (
                    <ModCard
                      key={`${mod.uid}:${mod.versionId}`}
                      mod={mod}
                      installed={installedMod}
                      active={selected?.uid === mod.uid}
                      favorite={favoriteUids.has(mod.uid.toLocaleLowerCase())}
                      busy={busy}
                      working={isBusy}
                      onSelect={() => setSelectedUid(mod.uid)}
                      onInstall={() => installMod(mod.uid, mod.downloadUrl)}
                      onUninstall={() => installedMod && setPendingUninstall(installedMod)}
                      onToggleFavorite={() => toggleFavorite(mod.uid)}
                    />
                  );
                })}
              </div>
              {totalPages > 1 && (
                <div className="vault-pagination">
                  <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} />
                </div>
              )}
            </section>
            {selected && (() => {
              const installedMod = installedByUid.get(selected.uid);
              const installing = installStatus.type === "installing" && installStatus.payload.uid === selected.uid;
              const toggling = toggleStatus.type === "toggling" && toggleStatus.payload.uid === selected.uid;
              return (
                <ModDetailPanel
                  mod={selected}
                  installed={installedMod}
                  favorite={favoriteUids.has(selected.uid.toLocaleLowerCase())}
                  busy={busy}
                  installing={installing}
                  toggling={toggling}
                  onInstall={() => installMod(selected.uid, selected.downloadUrl)}
                  onToggle={() => installedMod && toggleMod(installedMod.uid, !installedMod.enabled)}
                  onUninstall={() => installedMod && setPendingUninstall(installedMod)}
                  onToggleFavorite={() => toggleFavorite(selected.uid)}
                />
              );
            })()}
          </div>
        </>
      ) : null}
      {pendingUninstall && (
        <UninstallDialog
          modName={pendingUninstall.displayName}
          onCancel={() => setPendingUninstall(null)}
          onConfirm={() => {
            uninstallMod(pendingUninstall.folderName, pendingUninstall.uid);
            setPendingUninstall(null);
          }}
        />
      )}
    </>
  );
}

const SUB_VIEWS: Record<
  SubView,
  { label: MessageKey; Component: (props: { busy: boolean }) => JSX.Element }
> = {
  vault: { label: "mods.view.tab.vault", Component: VaultView },
  installed: { label: "mods.view.tab.installed", Component: InstalledModsView },
};

export function ModsView() {
  const { t } = useTranslation();
  const [subView, setSubView] = useState<SubView>("vault");
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const installed = useAppStore((state) => state.state.mods.installed);
  const installStatus = useAppStore((state) => state.state.mods.installStatus);
  const toggleStatus = useAppStore((state) => state.state.mods.toggleStatus);
  const busy = installStatus.type === "installing" || toggleStatus.type === "toggling";
  const { Component } = SUB_VIEWS[subView];
  return (
    <div className="mods-workspace">
      <div className="vault-subnav">
        <SectionTabs
          active={subView}
          ariaLabel={t("mods.view.modLibraryViews")}
          items={(Object.keys(SUB_VIEWS) as SubView[]).map((key) => ({ id: key, label: t(SUB_VIEWS[key].label) }))}
          onChange={setSubView}
        />
        <div className="vault-subnav-actions">
          <Button variant="ghost" onClick={() => setUploadModalOpen(true)}>
            <Icon name="upload" size={15} /> {t("uploads.title.mod")}
          </Button>
        </div>
      </div>
      <Component busy={busy} />
      {uploadModalOpen && (
        <ModUploadModal
          installed={installed}
          onClose={() => setUploadModalOpen(false)}
        />
      )}
    </div>
  );
}
