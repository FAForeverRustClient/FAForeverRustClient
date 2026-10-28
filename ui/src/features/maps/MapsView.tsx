import { type MapFilterState, type VaultSort, type VaultPreset, presetSort, storedVaultSort, mapVaultQuery, mapFilterFromQuery } from "./mapVaultFilters";
import { useVaultFilters, useVaultSearch } from "../../shared/hooks/useVaultFilters";
// Maps tab: vault discovery and installed-map management. The backend owns
// the map catalogue and installation state; this component only derives the
// current search, filters, sorting and selection for presentation.

import { useEffect, useMemo, useState } from "react";
import { type MapFilterDraft, type RankedFilter, useMapFilterDraft } from "./mapFilterDraft";
import { type InstallFilter, mapsByDownload, mapsMatchingQuery, visibleVaultMaps } from "./mapVaultResults";
import { StatusNotice } from "../../design-system/StatusNotice";
import { localPage, vaultPageOutcome } from "../../shared/vaultResults";
import { Button } from "../../design-system/Button";
import { Icon, type IconName } from "../../design-system/Icon";
import { native } from "../../ipc/native";
import { EmptyState } from "../../design-system/EmptyState";
import { SectionTabs, sectionPanelProps } from "../../design-system/SectionTabs";
import { RangeSlider } from "../../design-system/RangeSlider";
import {
  SearchField,
  SearchPanel,
  SearchPanelSubmit,
  SearchPanelToggle,
} from "../../design-system/SearchPanel";
// Only the from-disk entry point: publishing an installed map has its own modal.
import { openUploadFromDisk } from "../uploads/UploadDialog";
import { Pagination } from "../../design-system/Pagination";
import type { GeneratorStatus, InstalledMap, MapsSection, MapVaultQuery, VaultMap } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { GeneratorFailure } from "../../shared/components/GeneratorFailure";
import { FailureNotice, LoadStatusNotice } from "../../shared/components/LoadNotices";
import { plainError } from "../../shared/plainError";
import { toggleFavoriteMap } from "../../shared/favoriteMaps";
import { isWithinNumberRange } from "../../shared/filterRanges";
import { installNote, kilometres, kilometresLabel } from "../../shared/mapPresentation";
import { sameVaultSearch } from "../../shared/vaultQuery";
import { useAppStore } from "../../store/store";
import { MapPreview } from "../../shared/components/MapPreview";
import {
  findVaultMapByFolder,
  isGeneratedMap,
  isOfficialMap,
  mapInstalled,
  sizeLabel,
} from "../../shared/mapPresentation";
import { MapThumbnail } from "../../shared/components/MapThumbnail";
import { MapCard, MapDetailPanel, MapHideDialog, MapRating, MapUninstallDialog } from "./MapVaultComponents";
import { MapPreviewDialog } from "../../shared/components/MapPreviewZoom";
import { hasMapVaultFocus, takeMapVaultFocus } from "../../shared/mapVaultFocus";
import { GeneratorProgress, stillRunning } from "./GeneratorProgress";
import { commandOfCurrentRun, startRun } from "./generatorCommands";
import { DEFAULT_VAULT_PAGE_SIZE } from "../../shared/browsingPreferences";
import { pageFillerCount, useGridPageSize } from "../../shared/hooks/useGridPageSize";
import { GridPageFiller } from "../../shared/components/GridPageFiller";
import "./maps.css";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { DateInput } from "../../design-system/DateInput";
import {
  filterMemoryNow,
  isFilterRecord,
  rememberedFilter,
  useForgetFiltersOnLeave,
  useRememberFilter,
} from "../../shared/filterMemory";

type SubView = MapsSection;
const MAP_SIZES = [64, 128, 256, 512, 1024, 2048, 4096];
const INSTALLED_MAP_CARD_PX = 76;

const searchVault = (query: MapVaultQuery) => ipc.send({ kind: "Maps", command: { type: "searchVault", payload: { query } } });
const loadVault = () => ipc.send({ kind: "Maps", command: { type: "loadVault" } });
const loadInstalled = () => ipc.send({ kind: "Maps", command: { type: "loadInstalled" } });

const installMap = (folderName: string, downloadUrl: string) =>
  ipc.send({
    kind: "Maps",
    command: { type: "installMap", payload: { folderName, downloadUrl } },
  });

const uninstallMap = (folderName: string) =>
  ipc.send({
    kind: "Maps",
    command: { type: "uninstallMap", payload: { folderName } },
  });

const setMapVersionHidden = (versionId: number, hidden: boolean) =>
  ipc.send({
    kind: "Maps",
    command: { type: "setMapVersionHidden", payload: { versionId, hidden } },
  });

/** The vault's presets, in the order the buttons are drawn. */
const VAULT_PRESETS: Array<[VaultPreset, MessageKey]> = [
  ["recommended", "maps.view.preset.recommended"],
  ["favorites", "maps.view.preset.favorites"],
  ["mine", "maps.view.preset.mine"],
  // The unfiltered vault before the orderings of it.
  ["all", "maps.view.preset.all"],
  ["rating", "maps.view.preset.rating"],
  ["newest", "maps.view.preset.newest"],
  ["played", "maps.view.preset.played"],
];

/** Where the vault's and the library's filters are remembered (#447). */
const MAP_VAULT_FILTERS = "maps.vault";
const INSTALLED_MAP_FILTERS = "maps.installed";

function VaultView({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  // `vault` is the catalogue index, still loaded once and still what the
  // favourites preset and every map-art lookup read. `browse` is one page of a
  // server-side search, and is what this tab shows.
  const vault = useAppStore((state) => state.state.maps.vault);
  const vaultStatus = useAppStore((state) => state.state.maps.vaultStatus);
  const browse = useAppStore((state) => state.state.maps.browse);
  const browseStatus = useAppStore((state) => state.state.maps.browseStatus);
  const browseTotalPages = useAppStore((state) => state.state.maps.browseTotalPages);
  const browseTotalRecords = useAppStore((state) => state.state.maps.browseTotalRecords);
  // The query the page count in state was reported for. See `sameVaultSearch`.
  const browseQuery = useAppStore((state) => state.state.maps.browseQuery);
  const installed = useAppStore((state) => state.state.maps.installed);
  const installedStatus = useAppStore((state) => state.state.maps.installedStatus);
  const installStatus = useAppStore((state) => state.state.maps.installStatus);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  const visibilityStatus = useAppStore((state) => state.state.maps.visibilityStatus);
  // Who "my maps" and the hide buttons are about. Null until login, which is
  // why the preset is not offered before then: without an id the query would
  // silently widen to the whole vault.
  const playerId = useAppStore((state) => state.state.auth.player?.id ?? null);
  const storedPreset = (browsing.mapVaultPreset as VaultPreset) || "recommended";
  const preset: VaultPreset = storedPreset === "mine" && playerId === null ? "recommended" : storedPreset;
  // A sort the user chose outlives the tab they chose it on. Without this,
  // picking "Most recent", leaving for the lobby and coming back put the list
  // back in the preset's own order, which reads as the client forgetting.
  const initialSort: VaultSort =
    storedVaultSort(browsing.mapVaultSort) ?? presetSort(preset);
  const pageSize = browsing.vaultPageSize || DEFAULT_VAULT_PAGE_SIZE;
  // What was last searched, read once as the tab mounts: the form starts from
  // it, so coming back from another tab finds the search where it was left.
  // As long as the filter setting keeps it (#447): the copy remembered for
  // this tab, which also holds the install filter the query does not carry,
  // then the query in state.
  const [restored] = useState(() =>
    filterMemoryNow() === "never"
      ? null
      : rememberedFilter<MapFilterState | null>(MAP_VAULT_FILTERS, null, isFilterRecord)
        ?? mapFilterFromQuery(browseQuery, preset));
  const { draft, patchDraft: setFilter, setFilter: setField, applied, setApplied, page, setPage, applySearch, applySort, reset } = useVaultFilters<MapFilterState, VaultPreset>({
    initial: restored ?? {
      search: "",
      author: "",
      sort: initialSort,
      ranked: "all",
      installFilter: "all",
      createdAfter: "",
      createdBefore: "",
      showHidden: false,
      minimumRating: null,
      maximumRating: null,
      minimumPlayers: null,
      maximumPlayers: null,
      width: 0,
      height: 0,
    },
    initialPage: restored ? browseQuery.page : 1,
    memoryKey: MAP_VAULT_FILTERS, preset, presetSort,
  });
  const { search, author, sort, ranked, installFilter, createdAfter, createdBefore, showHidden, minimumRating, maximumRating, minimumPlayers, maximumPlayers, width, height } = draft;
  const setInstallFilter = (value: MapFilterState["installFilter"]) => setField("installFilter", value);
  const setCreatedAfter = (value: MapFilterState["createdAfter"]) => setField("createdAfter", value);
  const setCreatedBefore = (value: MapFilterState["createdBefore"]) => setField("createdBefore", value);
  const setShowHidden = (value: MapFilterState["showHidden"]) => setField("showHidden", value);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<VaultMap | null>(null);
  const [pendingHide, setPendingHide] = useState<VaultMap | null>(null);
  const [previewMap, setPreviewMap] = useState<VaultMap | null>(null);

  // With filters never remembered (#447), the next visit starts from the
  // default preset. The sort the preset brought is not a filter and stays.
  useForgetFiltersOnLeave(() => {
    if (useAppStore.getState().state.settings.browsing.mapVaultPreset === "recommended") return;
    ipc.send({
      kind: "Settings",
      command: { type: "patchBrowsing", payload: { patch: { mapVaultPreset: "recommended" } } },
    });
  });

  const installedFolders = useMemo(
    () => new Set(installed.map((map) => map.folderName.toLocaleLowerCase())),
    [installed],
  );
  const favoriteFolders = useMemo(
    () => new Set(browsing.favoriteMaps.map((folder) => folder.toLocaleLowerCase())),
    [browsing.favoriteMaps],
  );
  // The shared toggle, which also downloads a starred map that is not on
  // disk: the host dialog's favourites are the maps it can host.
  const toggleFavorite = (folderName: string, downloadUrl?: string) =>
    toggleFavoriteMap(folderName, downloadUrl);

  // The vault once per session (the service refuses a repeat); the installed
  // list on every visit, because the folder changes under the client.
  useEffect(() => {
    loadVault();
    loadInstalled();
  }, []);

  // Sorting is not a preset, and used to be routed through one: the select
  // called `choosePreset("all")`, which forced the sort back to "name" and
  // dropped whatever the preset was filtering on, so every choice but "Name"
  // appeared to do nothing and "My maps" quietly became all maps.
  //
  // It also read `sort` for the new value, which React has not applied yet at
  // that point, so the state it saved was the previous selection.
  const chooseSort = (nextSort: VaultSort) => {
    applySort(nextSort);
    if (browsing.mapVaultSort !== nextSort) {
      ipc.send({
        kind: "Settings",
        command: {
          type: "patchBrowsing",
          payload: { patch: { mapVaultSort: nextSort } },
        },
      });
    }
  };

  const choosePreset = (next: VaultPreset) => {
    const nextSort = presetSort(next);
    applySort(nextSort);
    if (browsing.mapVaultPreset !== next || browsing.mapVaultSort !== "") {
      ipc.send({
        kind: "Settings",
        command: {
          type: "patchBrowsing",
          // The preset brings its own order, so choosing one clears the
          // remembered sort rather than fighting it on the next load.
          payload: { patch: { mapVaultPreset: next, mapVaultSort: "" } },
        },
      });
    }
  };

  // Someone opened a map's preview somewhere else and asked to see it in the
  // vault. Only on mount: tabs are unmounted when they lose focus, so this
  // runs once per visit, and the request is cleared as it is read. The vault
  // is searched for the map's name and the version that was shown is
  // selected, so its panel opens on it.
  useEffect(() => {
    const focused = takeMapVaultFocus();
    if (!focused) return;
    setField("search", focused.name);
    setApplied((previous) => ({ ...previous, search: focused.name }));
    setPage(1);
    setSelectedFolder(focused.folderName || null);
    // A preset that narrows the list (recommended, favourites, my uploads,
    // played) could hide the very map that was asked for, so it gives way to
    // the whole vault. The sorting presets keep their order.
    if (preset !== "all" && preset !== "rating" && preset !== "newest") choosePreset("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearSearch = () => {
    reset({
      search: "",
      author: "",
      sort: "rating",
      ranked: "all",
      installFilter: "all",
      createdAfter: "",
      createdBefore: "",
      showHidden: false,
      minimumRating: null,
      maximumRating: null,
      minimumPlayers: null,
      maximumPlayers: null,
      width: 0,
      height: 0,
    });
    choosePreset("recommended");
  };

  // The search runs on the server, as it does in both reference clients. What
  // the user typed goes out as a query; the results come back as one page.
  const query = useMemo(
    () => mapVaultQuery(applied, preset, page, playerId, pageSize),
    [applied, preset, page, playerId, pageSize],
  );

  // `favorites` is the one preset the API cannot answer: it is local state the
  // server has never heard of. The favourites set is small and the catalogue
  // index is loaded anyway, so this preset keeps filtering the index and stays
  // exact, rather than becoming "favourites on this page".
  const localFavorites = preset === "favorites";
  // "Recently downloaded" (#453) is the other: when a map arrived is a fact
  // about this computer's map folder, which the server knows nothing of. The
  // downloaded maps are few and on disk, so the same local answer.
  const localDownloaded = applied.sort === "downloaded";
  const localList = localFavorites || localDownloaded;

  useVaultSearch(query, localList, searchVault);

  // The same query the server would have been sent, answered locally: the
  // search, author, ratings, slots, sizes, dates and sort all apply here too,
  // where they used to be shown and then ignored.
  const favorites = useMemo(() => {
    if (!localList) return [];
    const source = localFavorites
      ? vault.filter((map) => favoriteFolders.has(map.folderName.toLocaleLowerCase()))
      : vault;
    return localDownloaded ? mapsByDownload(source, installed, query) : mapsMatchingQuery(source, query);
  }, [localList, localFavorites, localDownloaded, vault, favoriteFolders, installed, query]);

  // The filters the server cannot answer for this tab, applied to the page
  // that came back. `MapsView`'s result count says "on this page" for exactly
  // this reason. See `mapVaultResults.ts` for why withdrawn versions are among
  // them even though the query asks about them. For favourites the list is
  // whole, so they apply to all of it before it is paged.
  const results = useMemo(
    () => visibleVaultMaps(localList ? favorites : browse, {
      showHidden: applied.showHidden,
      ownMaps: preset === "mine",
      installFilter: applied.installFilter,
      installedFolders,
    }),
    [applied.installFilter, applied.showHidden, browse, favorites, installedFolders, localList, preset],
  );

  // A page count belongs to the search that produced it. While a new filter's
  // results are still on their way, the count in state still describes the old
  // one, and a pager built from it offers pages this search does not have.
  // Favourites count what is left after every filter, not the starred total.
  const favoritePage = localPage(results, page, pageSize);
  const totalPages = localList
    ? favoritePage.totalPages
    : (sameVaultSearch(browseQuery, query) ? browseTotalPages ?? 1 : 1);
  const currentPage = localList ? favoritePage.currentPage : Math.min(page, totalPages);
  const pageMaps = localList ? favoritePage.items : results;
  // The install filter only ever sees one server page, so a page it empties
  // says so and keeps the pager, rather than claiming the search found nothing.
  const outcome = vaultPageOutcome({
    settled: localList ? vaultStatus.type === "ready" : browseStatus.type === "ready",
    received: localList ? results.length : browse.length,
    shown: pageMaps.length,
    currentPage,
    totalPages,
  });
  const selected = pageMaps.find((map) => map.folderName === selectedFolder) ?? pageMaps[0] ?? null;
  // Everything behind "More filters" that is not at its default, so the
  // button says how much it is hiding.
  const hiddenFilterCount = Number(ranked !== "all")
    + Number(minimumRating !== null || maximumRating !== null)
    + Number(minimumPlayers !== null || maximumPlayers !== null)
    + Number(installFilter !== "all")
    + Number(createdAfter !== "" || createdBefore !== "")
    + Number(width > 0)
    + Number(height > 0)
    + Number(showHidden);
  // The whole result, not the page: the server's total for its own search,
  // and the local lists counted after every filter. With the install filter
  // on, the server's total counts maps this page then hid, so the summary
  // falls back to what is on the page.
  const serverTotal = sameVaultSearch(browseQuery, query) ? browseTotalRecords : null;
  const totalLabel = localList
    ? t("lobby.host.mapCount", { count: results.length })
    : applied.installFilter === "all" && serverTotal !== null
      ? t("lobby.host.mapCount", { count: serverTotal })
      : t("maps.view.resultCount", { count: pageMaps.length });
  const presetLabel = VAULT_PRESETS.find(([key]) => key === preset)?.[1];
  const refresh = () => ipc.send({ kind: "Maps", command: { type: "searchVault", payload: { query } } });

  return (
    <>
      <SearchPanel
        className="map-search-panel"
        onSubmit={(event) => {
          event.preventDefault();
          applySearch();
        }}
        secondary={(
          <>
            {/* "My maps" only once there is an id to filter on: see
                `mapVaultQuery`. */}
            {VAULT_PRESETS.filter(([key]) => key !== "mine" || playerId !== null).map(([key, label]) => (
            <Button key={key} className={preset === key ? "active" : ""} onClick={() => choosePreset(key)} title={key === "favorites" ? t("maps.view.preset.favoritesTitle", { count: favoriteFolders.size }) : key === "mine" ? t("maps.view.preset.mineTitle") : undefined}>
              {key === "favorites" && <Icon name="star" size={14} fill="currentColor" />}
              {key === "mine" && <Icon name="user" size={14} />} {t(label)}
            </Button>
            ))}
            <span className="spacer" />
            <SearchPanelToggle expanded={filtersOpen} count={hiddenFilterCount} onClick={() => setFiltersOpen((open) => !open)} />
            <Button onClick={clearSearch}>{t("maps.view.clear")}</Button>
          </>
        )}
        advanced={filtersOpen ? (
          <div className="search-panel-advanced">
            <div className="search-panel-advanced-grid maps-advanced-grid">
              <SearchField label={t("maps.view.ranking")}>
                <select className="search-panel-control" value={ranked} onChange={(event) => setFilter({ ranked: event.target.value as RankedFilter })}><option value="all">{t("maps.view.any")}</option><option value="ranked">{t("maps.view.ranked")}</option><option value="unranked">{t("maps.view.unranked")}</option></select>
              </SearchField>
              <SearchField label={t("maps.view.installation")}><select className="search-panel-control" value={installFilter} onChange={(event) => setInstallFilter(event.target.value as InstallFilter)}><option value="all">{t("maps.view.any")}</option><option value="installed">{t("maps.view.installed")}</option><option value="available">{t("maps.view.notInstalled")}</option></select></SearchField>
              <RangeSlider
                label={t("maps.view.reviewScore")}
                min={0}
                max={5}
                step={0.5}
                low={minimumRating}
                high={maximumRating}
                format={(value) => `${value}★`}
                onChange={(low, high) => { setFilter({ minimumRating: low, maximumRating: high }); }}
              />
              <RangeSlider
                label={t("maps.view.playerSlots")}
                min={1}
                max={16}
                low={minimumPlayers}
                high={maximumPlayers}
                onChange={(low, high) => { setFilter({ minimumPlayers: low, maximumPlayers: high }); }}
              />
              <SearchField label={t("maps.view.width")}><select className="search-panel-control" value={width} onChange={(event) => setFilter({ width: Number(event.target.value) })}><option value={0}>{t("maps.view.any")}</option>{MAP_SIZES.map((value) => <option key={value} value={value}>{kilometres(kilometresLabel(value))}</option>)}</select></SearchField>
              <SearchField label={t("maps.view.height")}><select className="search-panel-control" value={height} onChange={(event) => setFilter({ height: Number(event.target.value) })}><option value={0}>{t("maps.view.any")}</option>{MAP_SIZES.map((value) => <option key={value} value={value}>{kilometres(kilometresLabel(value))}</option>)}</select></SearchField>
              <SearchField label={t("maps.view.uploadedAfter")}><DateInput className="search-panel-control" value={createdAfter} onChange={setCreatedAfter} /></SearchField>
              <SearchField label={t("maps.view.uploadedBefore")}><DateInput className="search-panel-control" value={createdBefore} onChange={setCreatedBefore} /></SearchField>
              {/* "My maps" shows them regardless, so the control would be a
                  lie there: an author is meant to see what they withdrew. */}
              {preset !== "mine" && (
                <SearchField label={t("maps.view.withdrawn")}>
                  <select
                    className="search-panel-control"
                    value={showHidden ? "include" : "exclude"}
                    title={t("maps.view.withdrawnTitle")}
                    onChange={(event) => setShowHidden(event.target.value === "include")}
                  >
                    <option value="exclude">{t("maps.view.withdrawnExclude")}</option>
                    <option value="include">{t("maps.view.withdrawnInclude")}</option>
                  </select>
                </SearchField>
              )}
            </div>
          </div>
        ) : undefined}
      >
        <SearchField label={t("maps.view.map")} className="search-panel-field-grow map-search-query">
          <input
            className="search-panel-control"
            value={search}
            onChange={(event) => {
              const value = event.target.value;
              setFilter({ search: value });
              if (value.trim() && preset === "recommended") choosePreset("all");
            }}
            // The name and nothing else, because that is all the vault's map
            // search looks at (`displayName` in `vault_query.rs`); it used to
            // promise the description and the folder as well.
            placeholder={t("maps.view.searchByName")}
          />
        </SearchField>
        <SearchField label={t("maps.view.author")} className="search-panel-field-grow map-search-author">
          <input
            className="search-panel-control"
            value={author}
            onChange={(event) => {
              const value = event.target.value;
              setFilter({ author: value });
              if (value.trim() && preset === "recommended") choosePreset("all");
            }}
            placeholder={t("maps.view.anyAuthor")}
          />
        </SearchField>
        {/* The search row is the name, the author and the button. The rest
            of the filters are behind "More filters", and the sort sits over
            the results it orders. */}
        <SearchPanelSubmit />
      </SearchPanel>

      <LoadStatusNotice
        status={vaultStatus}
        failed={t("maps.view.vaultFailed")}
        onRetry={loadVault}
      />
      {/* The search this page shows. Silent before: a new filter kept the
          previous cards on screen as though they matched it, and a failed
          search left those cards, or a blank area, with nothing said. */}
      {!localList && (
        <LoadStatusNotice
          status={browseStatus}
          failed={t("maps.view.searchFailed")}
          onRetry={refresh}
        />
      )}
      {/* An install or uninstall that failed only turned its button back to
          "Install"; the reason was in the store and nowhere on screen. */}
      <FailureNotice status={installStatus} message={installNote(installStatus)} />
      {installedStatus.type === "failed" && <p className="vault-note muted">{t("maps.view.detectionUnavailable")}</p>}
      {/* The refusal an author meets when they try to undo a hide: FAF allows
          only a map administrator to do that, so the reason has to be read.
          That one is the client's own sentence and passes through as it is;
          what `plainError` rewords is a transport failure, with the original
          on hover. No Retry: the refusal would only be repeated, and Hide or
          Unhide is still on the map's panel for any other cause. */}
      <FailureNotice
        status={visibilityStatus}
        message={visibilityStatus.type === "failed" ? plainError(visibilityStatus.payload.reason) : null}
      />
      {outcome.kind === "noMatch" ? (
        // An empty "my maps" is the ordinary state for most players rather
        // than a failed search, so it says so instead of suggesting the
        // filters be widened.
        preset === "mine" ? (
          <EmptyState
            bordered
            icon="maps"
            title={t("maps.view.emptyMine")}
            hint={t("maps.view.emptyMineHint")}
          />
        ) : (
          <EmptyState
            bordered
            icon={vault.length === 0 ? "maps" : "search"}
            title={t(vault.length === 0 ? "maps.view.emptyVault" : "maps.view.noMatch")}
            hint={t(vault.length === 0 ? "maps.view.emptyVaultHint" : "maps.view.noMatchHint")}
          >
            {vault.length > 0 && <Button onClick={clearSearch}>{t("maps.view.clear")}</Button>}
          </EmptyState>
        )
      ) : outcome.kind !== "waiting" && (
        <>
          <div
            className={!localList && browseStatus.type === "loading" ? "maps-vault-layout is-stale-results" : "maps-vault-layout"}
            aria-busy={!localList && browseStatus.type === "loading"}
          >
            {/* Over the grid's column only, as the mods tab has it: what the
                search found on the left, and at the grid's top right the order
                it is in and the way to ask again. */}
            <div className="maps-summary">
              <div className="maps-summary-count">
                <Icon name="maps" size={16} />
                <strong>{totalLabel}</strong>
                {presetLabel && <span className="muted">{t(presetLabel)}</span>}
              </div>
              <span className="spacer" />
              <label className="maps-summary-sort">
                <span className="muted">{t("maps.view.sortBy")}</span>
                <select className="search-panel-control" value={sort} onChange={(event) => chooseSort(event.target.value as VaultSort)}>
                  <option value="rating">{t("maps.view.preset.rating")}</option>
                  <option value="newest">{t("maps.view.preset.newest")}</option>
                  <option value="played">{t("maps.view.preset.played")}</option>
                  <option value="name">{t("maps.view.sort.name")}</option>
                  <option value="size">{t("maps.view.sort.size")}</option>
                  <option value="downloaded">{t("maps.view.sort.downloaded")}</option>
                </select>
              </label>
              {/* Re-runs the current search. It used to re-crawl the
                  catalogue, which the service now refuses once that has
                  succeeded. Nothing to ask again for a local list. */}
              {!localList && (
                <Button
                  variant="ghost"
                  className="maps-summary-icon"
                  aria-label={t("maps.view.refresh")}
                  title={t("maps.view.refresh")}
                  onClick={refresh}
                  disabled={browseStatus.type === "loading"}
                >
                  <Icon name="refresh" size={15} />
                </Button>
              )}
            </div>
            <section className="vault-browser maps-vault-browser">
              {/* Every map on this page fell to the install filter, which only
                  sees this page; the next one may well have some, so the pager
                  stays and the note points there. */}
              {outcome.kind !== "results" ? (
                <StatusNotice
                  tone="info"
                  action={outcome.nextPage === null ? undefined : {
                    label: t("maps.view.nextPage"),
                    onClick: () => setPage(outcome.nextPage ?? currentPage),
                  }}
                >
                  {t(outcome.kind === "filteredOnPage" ? "maps.view.pageFilteredOut" : "maps.view.pageEmpty")}
                </StatusNotice>
              ) : (
              <div className="map-vault-grid">
                {pageMaps.map((map) => {
                  const isInstalled = mapInstalled(map, installedFolders);
                  const isBusy = busy && installStatus.type === "installing" && installStatus.payload.folderName === map.folderName;
                  const favorite = favoriteFolders.has(map.folderName.toLocaleLowerCase());
                  return (
                    <MapCard
                      key={map.folderName}
                      map={map}
                      active={selected?.folderName === map.folderName}
                      installed={isInstalled}
                      busy={isBusy}
                      favorite={favorite}
                      onSelect={() => setSelectedFolder(map.folderName)}
                      onInstall={() => installMap(map.folderName, map.downloadUrl)}
                      onUninstall={() => setPendingUninstall(map)}
                      onToggleFavorite={() => toggleFavorite(map.folderName, map.downloadUrl)}
                    />
                  );
                })}
              </div>
              )}
              {outcome.showPager && (
                <div className="vault-pagination">
                  <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} />
                </div>
              )}
            </section>
            {selected && (
              <MapDetailPanel
                map={selected}
                installed={mapInstalled(selected, installedFolders)}
                busy={busy && installStatus.type === "installing" && installStatus.payload.folderName === selected.folderName}
                favorite={favoriteFolders.has(selected.folderName.toLocaleLowerCase())}
                mine={playerId !== null && selected.authorId === playerId}
                visibilityBusy={visibilityStatus.type === "working" && visibilityStatus.payload.versionId === selected.versionId}
                onInstall={() => installMap(selected.folderName, selected.downloadUrl)}
                onUninstall={() => setPendingUninstall(selected)}
                onHide={() => setPendingHide(selected)}
                onUnhide={() => setMapVersionHidden(selected.versionId, false)}
                onPreview={() => setPreviewMap(selected)}
                onToggleFavorite={() => toggleFavorite(selected.folderName, selected.downloadUrl)}
              />
            )}
          </div>
        </>
      )}

      {pendingUninstall && <MapUninstallDialog mapName={pendingUninstall.displayName} onCancel={() => setPendingUninstall(null)} onConfirm={() => { uninstallMap(pendingUninstall.folderName); setPendingUninstall(null); }} />}
      {pendingHide && <MapHideDialog mapName={pendingHide.displayName} onCancel={() => setPendingHide(null)} onConfirm={() => { setMapVersionHidden(pendingHide.versionId, true); setPendingHide(null); }} />}
      {previewMap && (
        <MapPreviewDialog
          vaultLink={false}
          map={previewMap}
          onClose={() => setPreviewMap(null)}
          meta={<>
            {sizeLabel(previewMap)} · {t("maps.view.playerCount", { count: previewMap.maxPlayers })}
            {typeof previewMap.ranked === "boolean" && (
              <>
                {" · "}
                <span className={previewMap.ranked ? "map-vault-type ranked" : "map-vault-type unranked"}>
                  {t(previewMap.ranked ? "maps.vault.ranked" : "maps.vault.unranked")}
                </span>
              </>
            )}
          </>}
        />
      )}
    </>
  );
}

type InstalledPreset = "all" | "favorites" | "ranked" | "custom" | "builtin";

const INSTALLED_PRESET_LABELS: Record<InstalledPreset, MessageKey> = {
  all: "maps.view.preset.all",
  favorites: "maps.view.preset.favorites",
  ranked: "maps.view.ranked",
  custom: "maps.view.preset.custom",
  builtin: "maps.view.preset.builtin",
};

const presetLabelOf = (preset: InstalledPreset): MessageKey => INSTALLED_PRESET_LABELS[preset];
type InstalledSort = "name" | "size" | "players" | "newest" | "rating" | "downloaded";

interface InstalledMapFilters {
  draft: MapFilterDraft;
  preset: InstalledPreset;
}

function InstalledView({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const installed = useAppStore((state) => state.state.maps.installed);
  const installedStatus = useAppStore((state) => state.state.maps.installedStatus);
  const vault = useAppStore((state) => state.state.maps.vault);
  const installStatus = useAppStore((state) => state.state.maps.installStatus);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  const favoriteFolders = useMemo(
    () => new Set(browsing.favoriteMaps.map((folder) => folder.toLocaleLowerCase())),
    [browsing.favoriteMaps],
  );

  // The Installed grid could not enlarge anything: half the maps a player
  // looks at were stuck at thumbnail size, which is the complaint the Vault's
  // zoom answers.
  const [previewMap, setPreviewMap] = useState<InstalledMap | VaultMap | null>(null);
  // The filters as the setting keeps them (#447). The sort is not one.
  const [remembered] = useState(() =>
    rememberedFilter<InstalledMapFilters | null>(INSTALLED_MAP_FILTERS, null, isFilterRecord));
  const { draft, setFilter, resetFilters } = useMapFilterDraft(remembered?.draft);
  const { search, author, ranked, minimumRating, maximumRating, minimumPlayers, maximumPlayers, width, height } = draft;
  const [preset, setPreset] = useState<InstalledPreset>(remembered?.preset ?? "all");
  useRememberFilter(INSTALLED_MAP_FILTERS, useMemo(() => ({ draft, preset }), [draft, preset]));
  const [sort, setSort] = useState<InstalledSort>("name");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledMap | null>(null);
  // A page of the installed list is as much of it as fits, unless the reader
  // has picked a number in Settings. Nothing is fetched here -- the whole list
  // is already on disk -- so the only thing a fixed count decided was how much
  // empty panel there was under the pager.
  const [fittedPageSize, installedGrid] = useGridPageSize(INSTALLED_MAP_CARD_PX, DEFAULT_VAULT_PAGE_SIZE);
  const pageSize = browsing.vaultPageSize || fittedPageSize;

  // The vault record of an installed folder, matched on the folder's base name
  // when the exact version is not there. The catalogue holds each map's
  // *latest* version only, so an exact match missed every installed older
  // version (`lena_river.v0008` beside a vault at `.v0009`), and the card then
  // read "Unranked" and the Ranked filter dropped the map (#416). The same
  // lookup the lobby rows and the ranked-game rule already use.
  const vaultRecordOf = useMemo(
    () => (folderName: string) => findVaultMapByFolder(vault, folderName),
    [vault],
  );

  useEffect(() => {
    loadInstalled();
    loadVault();
  }, []);

  const choosePreset = (next: InstalledPreset) => {
    setPreset(next);
    if (next === "all") setSort("name");
  };

  // Only what the toggle actually hides, as on the vault: everything but the
  // name and the author.
  const hiddenFilterCount = Number(ranked !== "all")
    + Number(minimumRating !== null || maximumRating !== null)
    + Number(minimumPlayers !== null || maximumPlayers !== null)
    + Number(width > 0)
    + Number(height > 0);

  const clearSearch = () => {
    resetFilters();
    setPreset("all");
    setSort("name");
    setPage(1);
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const authorQuery = author.trim().toLocaleLowerCase();
    return installed
      .filter((map) => {
        const meta = vaultRecordOf(map.folderName);
        const isFav = favoriteFolders.has(map.folderName.toLocaleLowerCase());
        const isOfficial = isOfficialMap(map.folderName);
        // A base-game map the vault has no record of is rated by definition;
        // the same rule the host dialog's map list applies.
        const isRankedMap = meta ? meta.ranked : isOfficial;

        if (preset === "favorites" && !isFav) return false;
        if (preset === "ranked" && !isRankedMap) return false;
        if (preset === "custom" && isOfficial) return false;
        if (preset === "builtin" && !isOfficial) return false;

        if (ranked === "ranked" && !isRankedMap) return false;
        if (ranked === "unranked" && isRankedMap) return false;

        if (authorQuery) {
          const mapAuthor = (meta?.author ?? "").toLocaleLowerCase();
          if (!mapAuthor.includes(authorQuery)) return false;
        }

        if (minimumRating !== null || maximumRating !== null) {
          if (!meta) return false;
          if (!isWithinNumberRange(meta.ratingTenths / 10, minimumRating, maximumRating)) return false;
        }

        const effectivePlayers = map.maxPlayers ?? meta?.maxPlayers;
        if (effectivePlayers !== undefined && !isWithinNumberRange(effectivePlayers, minimumPlayers, maximumPlayers)) {
          return false;
        }

        const effectiveWidth = map.width ?? meta?.width;
        const effectiveHeight = map.height ?? meta?.height;
        if (width !== 0 && effectiveWidth !== undefined && effectiveWidth !== width) return false;
        if (height !== 0 && effectiveHeight !== undefined && effectiveHeight !== height) return false;

        if (query) {
          const matches = [
            map.displayName,
            map.folderName,
            meta?.displayName ?? "",
            meta?.description ?? "",
            map.description ?? "",
          ].some((val) => val.toLocaleLowerCase().includes(query));
          if (!matches) return false;
        }

        return true;
      })
      .slice()
      .sort((left, right) => {
        const metaLeft = vaultRecordOf(left.folderName);
        const metaRight = vaultRecordOf(right.folderName);
        switch (sort) {
          case "name":
            return left.displayName.localeCompare(right.displayName);
          case "size": {
            const sizeLeft = (left.width ?? metaLeft?.width ?? 0) * (left.height ?? metaLeft?.height ?? 0);
            const sizeRight = (right.width ?? metaRight?.width ?? 0) * (right.height ?? metaRight?.height ?? 0);
            return sizeRight - sizeLeft;
          }
          case "players":
            return (right.maxPlayers ?? metaRight?.maxPlayers ?? 0) - (left.maxPlayers ?? metaLeft?.maxPlayers ?? 0);
          case "newest":
            return (Date.parse(metaRight?.createdAt ?? "") || 0) - (Date.parse(metaLeft?.createdAt ?? "") || 0);
          case "rating":
            return (metaRight?.ratingTenths ?? 0) - (metaLeft?.ratingTenths ?? 0);
          // The map downloaded last first (#453): for finding again a map
          // tried out a moment ago without having noted its name.
          case "downloaded":
            return (Date.parse(right.installedAt ?? "") || 0) - (Date.parse(left.installedAt ?? "") || 0);
        }
      });
  }, [
    installed, search, author, preset, sort, ranked, minimumRating, maximumRating,
    minimumPlayers, maximumPlayers, width, height, vaultRecordOf, favoriteFolders,
  ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageMaps = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  // The last page keeps a full page's height, so the pager stays put.
  const fillers = pageFillerCount({ shown: pageMaps.length, pageSize, fitted: fittedPageSize, totalPages });

  return (
    <>
      <SearchPanel
        className="installed-map-search-panel"
        onSubmit={(event) => { event.preventDefault(); setPage(1); }}
        secondary={(
          <>
            {([
              ["all", t("maps.view.preset.all")],
              ["favorites", t("maps.view.preset.favorites")],
              ["ranked", t("maps.view.ranked")],
              ["custom", t("maps.view.preset.custom")],
              ["builtin", t("maps.view.preset.builtin")],
            ] as Array<[InstalledPreset, string]>).map(([key, label]) => (
              <Button
                key={key}
                className={preset === key ? "active" : ""}
                onClick={() => choosePreset(key)}
                title={
                  key === "favorites"
                    ? t("maps.view.showFavorites", { count: favoriteFolders.size })
                    : undefined
                }
              >
                {key === "favorites" && <Icon name="star" size={14} fill="currentColor" />} {label}
              </Button>
            ))}
            <span className="spacer" />
            <SearchPanelToggle expanded={filtersOpen} count={hiddenFilterCount} onClick={() => setFiltersOpen((open) => !open)} />
            <Button onClick={clearSearch}>{t("maps.view.clear")}</Button>
          </>
        )}
        advanced={filtersOpen ? (
          <div className="search-panel-advanced">
            <div className="search-panel-advanced-grid maps-advanced-grid">
              <SearchField label={t("maps.view.ranking")}>
                <select className="search-panel-control" value={ranked} onChange={(event) => { setFilter({ ranked: event.target.value as RankedFilter }); setPage(1); }}>
                  <option value="all">{t("maps.view.any")}</option>
                  <option value="ranked">{t("maps.view.ranked")}</option>
                  <option value="unranked">{t("maps.view.unranked")}</option>
                </select>
              </SearchField>
              <SearchField label={t("maps.view.width")}>
                <select className="search-panel-control" value={width} onChange={(event) => setFilter({ width: Number(event.target.value) })}>
                  <option value={0}>{t("maps.view.any")}</option>
                  {MAP_SIZES.map((value) => <option key={value} value={value}>{kilometres(kilometresLabel(value))}</option>)}
                </select>
              </SearchField>
              <SearchField label={t("maps.view.height")}>
                <select className="search-panel-control" value={height} onChange={(event) => setFilter({ height: Number(event.target.value) })}>
                  <option value={0}>{t("maps.view.any")}</option>
                  {MAP_SIZES.map((value) => <option key={value} value={value}>{kilometres(kilometresLabel(value))}</option>)}
                </select>
              </SearchField>
              <RangeSlider
                label={t("maps.view.reviewScore")}
                min={0}
                max={5}
                step={0.5}
                low={minimumRating}
                high={maximumRating}
                format={(value) => `${value}★`}
                onChange={(low, high) => { setFilter({ minimumRating: low, maximumRating: high }); setPage(1); }}
              />
              <RangeSlider
                label={t("maps.view.playerSlots")}
                min={1}
                max={16}
                step={1}
                low={minimumPlayers}
                high={maximumPlayers}
                format={(value) => `${value}`}
                onChange={(low, high) => { setFilter({ minimumPlayers: low, maximumPlayers: high }); setPage(1); }}
              />
            </div>
          </div>
        ) : undefined}
      >
        <SearchField label={t("maps.view.map")} className="search-panel-field-grow map-search-query">
          <input
            className="search-panel-control"
            value={search}
            onChange={(event) => {
              setFilter({ search: event.target.value });
              setPage(1);
            }}
            placeholder={t("maps.view.searchInstalledMaps")}
          />
        </SearchField>
        <SearchField label={t("maps.view.author")} className="search-panel-field-grow map-search-author">
          <input
            className="search-panel-control"
            value={author}
            onChange={(event) => {
              setFilter({ author: event.target.value });
              setPage(1);
            }}
            placeholder={t("maps.view.anyAuthor")}
          />
        </SearchField>
      </SearchPanel>

      <LoadStatusNotice
        status={installedStatus}
        failed={t("maps.view.scanFailed")}
        onRetry={loadInstalled}
      />
      <FailureNotice status={installStatus} message={installNote(installStatus)} />
      {installedStatus.type === "ready" && filtered.length === 0 ? (
        <EmptyState
          bordered
          icon={installed.length === 0 ? "maps" : "search"}
          title={t(installed.length === 0 ? "maps.view.noneInstalled" : "maps.view.noInstalledMatch")}
          hint={t(installed.length === 0 ? "maps.view.noneInstalledHint" : "maps.view.noInstalledMatchHint")}
        >
          {/* The way out of "nothing matches", where the reason is a filter. */}
          {installed.length > 0 && (
            <Button onClick={clearSearch}>{t("maps.view.clear")}</Button>
          )}
        </EmptyState>
      ) : filtered.length > 0 && (
        <section className="installed-map-library">
          {/* The vault's summary line: how many, then the order and the
              library's own housekeeping at the right. */}
          <div className="maps-summary installed-map-summary">
            <div className="maps-summary-count">
              <Icon name="folder" size={16} />
              <strong>{t("lobby.host.mapCount", { count: filtered.length })}</strong>
              {preset !== "all" && <span className="muted">{t(presetLabelOf(preset))}</span>}
            </div>
            <span className="spacer" />
            <label className="maps-summary-sort">
              <span className="muted">{t("maps.view.sortBy")}</span>
              <select className="search-panel-control" value={sort} onChange={(event) => setSort(event.target.value as InstalledSort)}>
                <option value="name">{t("maps.view.sort.name")}</option>
                <option value="size">{t("maps.view.sort.size")}</option>
                <option value="players">{t("maps.view.sort.players")}</option>
                <option value="rating">{t("maps.view.preset.rating")}</option>
                <option value="newest">{t("maps.view.preset.newest")}</option>
                <option value="downloaded">{t("maps.view.sort.downloaded")}</option>
              </select>
            </label>
            {/* Housekeeping for the library rather than a filter. Generated
                maps are reproducible from their name, so removing them costs
                nothing but reclaims the disk a season of ladder accumulates. */}
            <Button variant="ghost" className="maps-summary-tool" onClick={cleanUpGeneratedMaps}>
              {t("maps.view.clearGenerated")}
            </Button>
            <Button
              variant="ghost"
              className="maps-summary-icon"
              aria-label={t("maps.view.rescan")}
              title={t("maps.view.rescan")}
              onClick={loadInstalled}
              disabled={installedStatus.type === "loading"}
            >
              <Icon name="refresh" size={15} />
            </Button>
          </div>
          <div className="installed-map-grid" ref={installedGrid}>
            {pageMaps.map((map) => {
              const metadata = vaultRecordOf(map.folderName);
              const isBusy = busy && installStatus.type === "installing" && installStatus.payload.folderName === map.folderName;
              // A Neroxis map has no vault record and no CDN preview: its
              // picture is the one the generator wrote into its folder, read
              // the way the lobby reads it, and the generator's logo as the
              // picture where there is none yet.
              const generated = isGeneratedMap(map.folderName);
              return (
                <article className="installed-map-card surface-panel" key={map.folderName}>
                  <button
                    type="button"
                    className="installed-map-preview-button"
                    onClick={() => setPreviewMap(metadata ?? map)}
                    aria-label={t("maps.preview.enlarge", { name: metadata?.displayName || map.displayName })}
                    title={t("maps.preview.enlarge", { name: metadata?.displayName || map.displayName })}
                  >
                    {generated ? (
                      <MapThumbnail
                        mapName={map.folderName}
                        vault={vault}
                        className="map-vault-thumb"
                        placeholderClassName="map-vault-thumb map-vault-preview-empty"
                      />
                    ) : (
                      <MapPreview map={metadata ?? map} />
                    )}
                  </button>
                  {/* The name gets the whole line, and the rating sits in the
                      corner rather than at the end of the facts line, where
                      it was the part that got cut off. */}
                  <span>
                    <span className="installed-map-title-row">
                      <strong title={metadata?.displayName || map.displayName}>{metadata?.displayName || map.displayName}</strong>
                    </span>
                    <small>{map.folderName}</small>
                    <small>
                      {sizeLabel(metadata ?? { width: map.width ?? 512, height: map.height ?? 512 })}
                      {" · "}
                      {t("maps.view.playerCount", { count: map.maxPlayers ?? metadata?.maxPlayers ?? 2 })}
                    </small>
                  </span>
                  <span className="installed-map-side">
                    {/* This corner said Ranked/Unranked, and said "Unranked"
                        for every folder it could not find in the vault (#416).
                        It shows the rating now, and nothing for a map nobody
                        has reviewed. */}
                    <MapRating map={metadata} />
                    <span className="installed-map-actions">
                      <Button
                        className="map-vault-open-folder is-icon"
                        aria-label={t("common.openFolderNamed", { name: metadata?.displayName || map.displayName })}
                        title={t("common.openFolder")}
                        onClick={() => void native.openInstalledFolder("maps", map.folderName)}
                      >
                        <Icon name="folder" size={14} />
                      </Button>
                      {/* An icon rather than the word. "Uninstall" in red was
                          the loudest thing on a row whose subject is the map,
                          and it is the one action here that cannot be undone
                          without a download. */}
                      <Button
                        className="map-vault-uninstall is-icon"
                        disabled={isBusy}
                        aria-label={t("maps.view.uninstallNamed", { name: metadata?.displayName || map.displayName })}
                        title={t(isBusy ? "maps.view.removing" : "maps.view.uninstall")}
                        onClick={() => setPendingUninstall(map)}
                      >
                        <Icon name="trash" size={14} />
                      </Button>
                    </span>
                  </span>
                </article>
              );
            })}
            <GridPageFiller count={fillers} cardClassName="installed-map-card surface-panel" />
          </div>
          {totalPages > 1 && (
            <div className="vault-pagination">
              <Pagination
                currentPage={currentPage}
                totalPages={totalPages}
                onPageChange={setPage}
              />
            </div>
          )}
        </section>
      )}
      {previewMap && (
        <MapPreviewDialog
          vaultLink={false}
          map={previewMap}
          onClose={() => setPreviewMap(null)}
          meta={<>{sizeLabel(previewMap)} · {t("maps.view.playerCount", { count: previewMap.maxPlayers ?? 2 })}</>}
        />
      )}
      {pendingUninstall && (
        <MapUninstallDialog
          mapName={pendingUninstall.displayName}
          onCancel={() => setPendingUninstall(null)}
          onConfirm={() => {
            uninstallMap(pendingUninstall.folderName);
            setPendingUninstall(null);
          }}
        />
      )}
    </>
  );
}

const SUB_VIEWS: Record<SubView, { label: MessageKey; icon: IconName; Component: (props: { busy: boolean }) => JSX.Element }> = {
  vault: { label: "maps.view.tab.vault", icon: "globe", Component: VaultView },
  installed: { label: "maps.view.tab.installed", icon: "folder", Component: InstalledView },
};

const cleanUpGeneratedMaps = () =>
  ipc.send({ kind: "MapGenerator", command: { type: "cleanUp" } });

/**
 * The sub-view is the backend's, like the Play tab's mode, so it survives the
 * tab unmounting: coming back to Maps lands on the list that was left, not on
 * the vault every time.
 */
const selectSubView = (section: SubView) =>
  ipc.send({ kind: "Nav", command: { type: "selectMapsSection", payload: { section } } });

export function MapsView() {
  const { t } = useTranslation();
  const subView = useAppStore((state) => state.state.nav.mapsSection);
  const installStatus = useAppStore((state) => state.state.maps.installStatus);
  const busy = installStatus.type === "installing";
  const { Component } = SUB_VIEWS[subView];

  // A jump to a map from another tab lands on the vault, where the vault view
  // then takes the request as it mounts.
  useEffect(() => {
    if (useAppStore.getState().state.nav.mapsSection === "vault") return;
    if (hasMapVaultFocus()) selectSubView("vault");
  }, []);

  return (
    <div className="maps-workspace">
      {/* The two lists as tabs, as the mods tab and the leaderboard have
          them, and at the end of the same line the one thing that is about
          neither: publishing a map of your own. Quiet, so it does not read as
          a third tab. Generating a map belongs to hosting a game, which is
          where its dialog is reached from. */}
      <header className="maps-header">
        <SectionTabs
          className="maps-section-tabs"
          active={subView}
          ariaLabel={t("maps.view.mapLibraryViews")}
          items={(Object.keys(SUB_VIEWS) as SubView[]).map((key) => ({
            id: key,
            label: <><Icon name={SUB_VIEWS[key].icon} size={15} /> {t(SUB_VIEWS[key].label)}</>,
          }))}
          onChange={selectSubView}
          idPrefix="maps-section"
        />
        <Button variant="ghost" className="maps-header-action" onClick={() => void openUploadFromDisk("map")}>
          <Icon name="upload" size={15} /> {t("maps.view.uploadFromDisk")}
        </Button>
      </header>
      <div {...sectionPanelProps("maps-section", subView)}>
        <Component busy={busy} />
      </div>
      <GeneratorStatusLine />
    </div>
  );
}

/**
 * The generator's run, below the lists.
 *
 * The generator is started from the host dialog now, but this is still where
 * its output lands, and a run is slow enough that the user will have walked
 * away from the dialog long before it finishes. A run that failed after the
 * dialog was closed used to leave nothing here at all, because the line was
 * only drawn while a run was busy; the failure stays now until it is
 * dismissed or the next run begins, with Retry when the run was sent from
 * this client and nothing has begun since (see `commandOfCurrentRun`).
 */
function GeneratorStatusLine() {
  const status = useAppStore((state) => state.state.mapGenerator.status);
  // The failure the reader dismissed, by identity: the status keeps the same
  // object until the next run, and that run's failure is a new one.
  const [dismissed, setDismissed] = useState<GeneratorStatus | null>(null);
  if (stillRunning(status)) {
    return <div className="maps-generator-status surface"><GeneratorProgress /></div>;
  }
  if (status.type !== "failed" || status === dismissed) return null;
  const command = commandOfCurrentRun();
  return (
    <GeneratorFailure
      reason={status.payload.reason}
      onRetry={command ? () => startRun(command) : undefined}
      onDismiss={() => setDismissed(status)}
    />
  );
}
