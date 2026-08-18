// Maps tab: vault discovery and installed-map management. The backend owns
// the map catalogue and installation state; this component only derives the
// current search, filters, sorting and selection for presentation.

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { EmptyState } from "../../design-system/EmptyState";
import { SectionTabs } from "../../design-system/SectionTabs";
import { RangeSlider } from "../../design-system/RangeSlider";
import {
  SearchField,
  SearchPanel,
  SearchPanelSubmit,
  SearchPanelToggle,
} from "../../design-system/SearchPanel";
import { Modal } from "../../design-system/Modal";
import { Pagination } from "../../design-system/Pagination";
import type { InstalledMap, VaultMap } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { loadStatusNote } from "../../shared/loadStatusNote";
import { isWithinDateRange, isWithinNumberRange, sortByDateDesc } from "../../shared/filterRanges";
import { useAppStore } from "../../store/store";
import {
  installNote,
  isOfficialMap,
  MapCard,
  MapDetailPanel,
  mapInstalled,
  MapPreview,
  MapUninstallDialog,
  ratingLabel,
  sizeLabel,
} from "./MapVaultComponents";
import { GenerateMapModal, GeneratorProgress, stillRunning } from "./GenerateMapModal";
import { MapUploadModal } from "./MapUploadModal";
import "./maps.css";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

type SubView = "vault" | "installed";
type VaultSort = "rating" | "newest" | "played" | "name" | "size";
type RankedFilter = "all" | "ranked" | "unranked";
type InstallFilter = "all" | "installed" | "available";
type VaultPreset = "recommended" | "favorites" | "rating" | "newest" | "played" | "all";

const PAGE_SIZE = 36;
const MAP_SIZES = [64, 128, 256, 512, 1024, 2048, 4096];

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

interface MapFilterState {
  search: string;
  author: string;
  sort: VaultSort;
  ranked: RankedFilter;
  installFilter: InstallFilter;
  createdAfter: string;
  createdBefore: string;
  minimumRating: number | null;
  maximumRating: number | null;
  minimumPlayers: number | null;
  maximumPlayers: number | null;
  width: number;
  height: number;
}

function VaultView({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.maps.vault);
  const vaultStatus = useAppStore((state) => state.state.maps.vaultStatus);
  const installed = useAppStore((state) => state.state.maps.installed);
  const installedStatus = useAppStore((state) => state.state.maps.installedStatus);
  const installStatus = useAppStore((state) => state.state.maps.installStatus);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  const preset = (browsing.mapVaultPreset as VaultPreset) || "recommended";
  const initialSort: VaultSort = (() => {
    if (preset === "newest") return "newest";
    if (preset === "played") return "played";
    if (preset === "all") return "name";
    return "rating";
  })();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<VaultSort>(initialSort);
  const [ranked, setRanked] = useState<RankedFilter>("all");
  const [installFilter, setInstallFilter] = useState<InstallFilter>("all");
  const [author, setAuthor] = useState("");
  const [createdAfter, setCreatedAfter] = useState("");
  const [createdBefore, setCreatedBefore] = useState("");
  const [minimumRating, setMinimumRating] = useState<number | null>(null);
  const [maximumRating, setMaximumRating] = useState<number | null>(null);
  const [minimumPlayers, setMinimumPlayers] = useState<number | null>(null);
  const [maximumPlayers, setMaximumPlayers] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<VaultMap | null>(null);
  const [previewMap, setPreviewMap] = useState<VaultMap | null>(null);

  const [applied, setApplied] = useState<MapFilterState>({
    search: "",
    author: "",
    sort: initialSort,
    ranked: "all",
    installFilter: "all",
    createdAfter: "",
    createdBefore: "",
    minimumRating: null,
    maximumRating: null,
    minimumPlayers: null,
    maximumPlayers: null,
    width: 0,
    height: 0,
  });

  const note = loadStatusNote(vaultStatus, t("maps.view.loadingVault"), t("maps.view.vaultFailed"));
  const installedFolders = useMemo(
    () => new Set(installed.map((map) => map.folderName.toLocaleLowerCase())),
    [installed],
  );
  const favoriteFolders = useMemo(
    () => new Set(browsing.favoriteMaps.map((folder) => folder.toLocaleLowerCase())),
    [browsing.favoriteMaps],
  );
  const toggleFavorite = (folderName: string) => {
    const key = folderName.trim().toLocaleLowerCase();
    const favoriteMaps = favoriteFolders.has(key)
      ? browsing.favoriteMaps.filter((favorite) => favorite.toLocaleLowerCase() !== key)
      : [...browsing.favoriteMaps, key];
    ipc.send({
      kind: "Settings",
      command: { type: "setBrowsing", payload: { preferences: { ...browsing, favoriteMaps } } },
    });
  };

  useEffect(() => {
    const maps = useAppStore.getState().state.maps;
    if (maps.vaultStatus.type === "idle") loadVault();
    if (maps.installedStatus.type === "idle") loadInstalled();
  }, []);

  useEffect(() => {
    if (preset === "newest") {
      setSort("newest");
      setApplied((prev) => ({ ...prev, sort: "newest" }));
    } else if (preset === "played") {
      setSort("played");
      setApplied((prev) => ({ ...prev, sort: "played" }));
    } else if (preset === "all") {
      setSort("name");
      setApplied((prev) => ({ ...prev, sort: "name" }));
    } else if (preset === "rating" || preset === "recommended" || preset === "favorites") {
      setSort("rating");
      setApplied((prev) => ({ ...prev, sort: "rating" }));
    }
  }, [preset]);

  const applySearch = () => {
    setApplied({
      search,
      author,
      sort,
      ranked,
      installFilter,
      createdAfter,
      createdBefore,
      minimumRating,
      maximumRating,
      minimumPlayers,
      maximumPlayers,
      width,
      height,
    });
    setPage(1);
  };

  const choosePreset = (next: VaultPreset) => {
    let nextSort: VaultSort = sort;
    if (next === "rating" || next === "recommended" || next === "favorites") nextSort = "rating";
    if (next === "newest") nextSort = "newest";
    if (next === "played") nextSort = "played";
    if (next === "all") nextSort = "name";
    setSort(nextSort);
    setApplied((prev) => ({ ...prev, sort: nextSort }));
    setPage(1);
    if (browsing.mapVaultPreset !== next) {
      ipc.send({
        kind: "Settings",
        command: { type: "setBrowsing", payload: { preferences: { ...browsing, mapVaultPreset: next } } },
      });
    }
  };

  const clearSearch = () => {
    setSearch("");
    setAuthor("");
    setRanked("all");
    setInstallFilter("all");
    setCreatedAfter("");
    setCreatedBefore("");
    setMinimumRating(null);
    setMaximumRating(null);
    setMinimumPlayers(null);
    setMaximumPlayers(null);
    setWidth(0);
    setHeight(0);
    setApplied({
      search: "",
      author: "",
      sort: "rating",
      ranked: "all",
      installFilter: "all",
      createdAfter: "",
      createdBefore: "",
      minimumRating: null,
      maximumRating: null,
      minimumPlayers: null,
      maximumPlayers: null,
      width: 0,
      height: 0,
    });
    setPage(1);
    choosePreset("recommended");
  };

  const filtered = useMemo(() => {
    const query = applied.search.trim().toLocaleLowerCase();
    // Hoisted out of the loop: the shared range helpers normalise their query
    // on every call, which over 5005 maps is 5005 identical trims.
    const authorQuery = applied.author.trim().toLocaleLowerCase();
    const hasDateFilter = Boolean(applied.createdAfter || applied.createdBefore);

    // One pass rather than a chain of `.filter()` calls. Each link in that chain
    // allocated a fresh array of up to 5005 maps, and the search predicate built
    // a five-element array per map on top of it.
    const matches: VaultMap[] = [];
    for (const map of vault) {
      if (preset === "recommended" && !map.recommended) continue;
      if (preset === "favorites" && !favoriteFolders.has(map.folderName.toLocaleLowerCase())) continue;
      if (applied.ranked !== "all" && map.ranked !== (applied.ranked === "ranked")) continue;
      if (authorQuery && !(map.author ?? "").toLocaleLowerCase().includes(authorQuery)) continue;
      if (hasDateFilter && !isWithinDateRange(map.createdAt, applied.createdAfter, applied.createdBefore)) continue;
      if (!isWithinNumberRange(map.ratingTenths / 10, applied.minimumRating, applied.maximumRating)) continue;
      if (!isWithinNumberRange(map.maxPlayers, applied.minimumPlayers, applied.maximumPlayers)) continue;
      if (applied.width !== 0 && map.width !== applied.width) continue;
      if (applied.height !== 0 && map.height !== applied.height) continue;
      if (applied.installFilter !== "all"
        && mapInstalled(map, installedFolders) !== (applied.installFilter === "installed")) continue;
      if (query
        && !map.displayName.toLocaleLowerCase().includes(query)
        && !(map.author ?? "").toLocaleLowerCase().includes(query)
        && !map.folderName.toLocaleLowerCase().includes(query)
        && !map.description.toLocaleLowerCase().includes(query)
        && !map.mapType.toLocaleLowerCase().includes(query)) continue;
      matches.push(map);
    }

    if (applied.sort === "newest") return sortByDateDesc(matches, (map) => map.createdAt);
    return matches.sort((left, right) => {
      switch (applied.sort) {
        case "rating": return right.ratingTenths - left.ratingTenths || right.reviews - left.reviews;
        case "played": return right.gamesPlayed - left.gamesPlayed;
        case "size": return right.width * right.height - left.width * left.height;
        case "name": return left.displayName.localeCompare(right.displayName);
        default: return 0;
      }
    });
  }, [
    vault, preset, favoriteFolders, applied, installedFolders,
  ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageMaps = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selected = pageMaps.find((map) => map.folderName === selectedFolder) ?? pageMaps[0] ?? null;
  const hiddenFilterCount = Number(installFilter !== "all")
    + Number(createdAfter !== "" || createdBefore !== "")
    + Number(width > 0)
    + Number(height > 0);

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
            {([
              ["recommended", t("maps.view.preset.recommended")],
              ["favorites", t("maps.view.preset.favorites")],
              ["rating", t("maps.view.preset.rating")],
              ["newest", t("maps.view.preset.newest")],
              ["played", t("maps.view.preset.played")],
              ["all", t("maps.view.preset.all")],
            ] as Array<[VaultPreset, string]>).map(([key, label]) => (
            <Button key={key} className={preset === key ? "active" : ""} onClick={() => choosePreset(key)} title={key === "favorites" ? `Show ${favoriteFolders.size} favorited maps` : undefined}>
              {key === "favorites" && <Icon name="star" size={14} fill="currentColor" />} {label}
            </Button>
            ))}
            <span className="spacer" />
            <SearchPanelToggle expanded={filtersOpen} count={hiddenFilterCount} onClick={() => setFiltersOpen((open) => !open)} />
            <Button onClick={clearSearch}>{t("maps.view.clear")}</Button>
            <Button onClick={loadVault} disabled={vaultStatus.type === "loading"}><Icon name="refresh" size={15} /> {t("maps.view.refresh")}</Button>
          </>
        )}
        advanced={filtersOpen ? (
          <div className="search-panel-advanced">
            <div className="search-panel-advanced-grid">
              <SearchField label={t("maps.view.installation")}><select className="search-panel-control" value={installFilter} onChange={(event) => setInstallFilter(event.target.value as InstallFilter)}><option value="all">{t("maps.view.any")}</option><option value="installed">{t("maps.view.installed")}</option><option value="available">{t("maps.view.notInstalled")}</option></select></SearchField>
              <SearchField label={t("maps.view.uploadedAfter")}><input className="search-panel-control" type="date" value={createdAfter} onChange={(event) => setCreatedAfter(event.target.value)} /></SearchField>
              <SearchField label={t("maps.view.uploadedBefore")}><input className="search-panel-control" type="date" value={createdBefore} onChange={(event) => setCreatedBefore(event.target.value)} /></SearchField>
              <SearchField label={t("maps.view.width")}><select className="search-panel-control" value={width} onChange={(event) => setWidth(Number(event.target.value))}><option value={0}>{t("maps.view.any")}</option>{MAP_SIZES.map((value) => <option key={value} value={value}>{(value / 51.2).toFixed(0)} km</option>)}</select></SearchField>
              <SearchField label={t("maps.view.height")}><select className="search-panel-control" value={height} onChange={(event) => setHeight(Number(event.target.value))}><option value={0}>{t("maps.view.any")}</option>{MAP_SIZES.map((value) => <option key={value} value={value}>{(value / 51.2).toFixed(0)} km</option>)}</select></SearchField>
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
              setSearch(value);
              if (value.trim() && preset === "recommended") choosePreset("all");
            }}
            placeholder={t("maps.view.nameDescriptionFolder")}
          />
        </SearchField>
        <SearchField label={t("maps.view.author")} className="search-panel-field-grow map-search-author">
          <input
            className="search-panel-control"
            value={author}
            onChange={(event) => {
              const value = event.target.value;
              setAuthor(value);
              if (value.trim() && preset === "recommended") choosePreset("all");
            }}
            placeholder={t("maps.view.anyAuthor")}
          />
        </SearchField>
        <RangeSlider
          label={t("maps.view.reviewScore")}
          min={0}
          max={5}
          step={0.5}
          low={minimumRating}
          high={maximumRating}
          format={(value) => `${value}★`}
          onChange={(low, high) => { setMinimumRating(low); setMaximumRating(high); }}
        />
        <RangeSlider
          label={t("maps.view.playerSlots")}
          min={1}
          max={16}
          low={minimumPlayers}
          high={maximumPlayers}
          onChange={(low, high) => { setMinimumPlayers(low); setMaximumPlayers(high); }}
        />
        <SearchField label={t("maps.view.ranking")} className="search-panel-field-compact">
          <select className="search-panel-control" value={ranked} onChange={(event) => setRanked(event.target.value as RankedFilter)}><option value="all">{t("maps.view.any")}</option><option value="ranked">{t("maps.view.ranked")}</option><option value="unranked">{t("maps.view.unranked")}</option></select>
        </SearchField>
        <SearchField label={t("maps.view.sortBy")} className="search-panel-field-compact">
          <select className="search-panel-control" value={sort} onChange={(event) => { setSort(event.target.value as VaultSort); choosePreset("all"); }}><option value="rating">{t("maps.view.preset.rating")}</option><option value="newest">{t("maps.view.preset.newest")}</option><option value="played">{t("maps.view.preset.played")}</option><option value="name">{t("maps.view.sort.name")}</option><option value="size">{t("maps.view.sort.size")}</option></select>
        </SearchField>
        <SearchPanelSubmit />
      </SearchPanel>

      {note && <p className="vault-note muted">{note}</p>}
      {installedStatus.type === "failed" && <p className="vault-note muted">{t("maps.view.detectionUnavailable")}</p>}
      {vaultStatus.type === "ready" && filtered.length === 0 ? (
        <EmptyState
          bordered
          icon={vault.length === 0 ? "maps" : "search"}
          title={t(vault.length === 0 ? "maps.view.emptyVault" : "maps.view.noMatch")}
          hint={t(vault.length === 0 ? "maps.view.emptyVaultHint" : "maps.view.noMatchHint")}
        />
      ) : pageMaps.length > 0 && (
        <>
          <div className="vault-results-head"><span>{filtered.length} {filtered.length === 1 ? "map" : "maps"}</span><span>Page {currentPage} of {totalPages}</span></div>
          <div className="vault-layout">
            <section className="vault-browser">
              <div className="map-vault-grid">
                {pageMaps.map((map) => {
                  const isInstalled = mapInstalled(map, installedFolders);
                  const isBusy = busy && installStatus.type === "installing" && installStatus.payload.folderName === map.folderName;
                  const favorite = favoriteFolders.has(map.folderName.toLocaleLowerCase());
                  return <MapCard key={map.folderName} map={map} active={selected?.folderName === map.folderName} installed={isInstalled} busy={isBusy} favorite={favorite} onSelect={() => setSelectedFolder(map.folderName)} onInstall={() => installMap(map.folderName, map.downloadUrl)} onToggleFavorite={() => toggleFavorite(map.folderName)} />;
                })}
              </div>
              {totalPages > 1 && (
                <div className="vault-pagination">
                  <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setPage} />
                </div>
              )}
            </section>
            {selected && <MapDetailPanel map={selected} installed={mapInstalled(selected, installedFolders)} busy={busy && installStatus.type === "installing" && installStatus.payload.folderName === selected.folderName} favorite={favoriteFolders.has(selected.folderName.toLocaleLowerCase())} onInstall={() => installMap(selected.folderName, selected.downloadUrl)} onUninstall={() => setPendingUninstall(selected)} onPreview={() => setPreviewMap(selected)} onToggleFavorite={() => toggleFavorite(selected.folderName)} />}
          </div>
        </>
      )}

      {pendingUninstall && <MapUninstallDialog mapName={pendingUninstall.displayName} onCancel={() => setPendingUninstall(null)} onConfirm={() => { uninstallMap(pendingUninstall.folderName); setPendingUninstall(null); }} />}
      {previewMap && <Modal onClose={() => setPreviewMap(null)}><div className="map-preview-dialog"><h2>{previewMap.displayName}</h2><MapPreview map={previewMap} large /><p>{sizeLabel(previewMap)} · {previewMap.maxPlayers} players</p></div></Modal>}
    </>
  );
}

type InstalledPreset = "all" | "favorites" | "ranked" | "custom" | "builtin";
type InstalledSort = "name" | "size" | "players" | "newest" | "rating";

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

  const [search, setSearch] = useState("");
  const [author, setAuthor] = useState("");
  const [preset, setPreset] = useState<InstalledPreset>("all");
  const [sort, setSort] = useState<InstalledSort>("name");
  const [ranked, setRanked] = useState<RankedFilter>("all");
  const [minimumRating, setMinimumRating] = useState<number | null>(null);
  const [maximumRating, setMaximumRating] = useState<number | null>(null);
  const [minimumPlayers, setMinimumPlayers] = useState<number | null>(null);
  const [maximumPlayers, setMaximumPlayers] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const [height, setHeight] = useState(0);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledMap | null>(null);

  const note = loadStatusNote(installedStatus, t("maps.view.scanning"), t("maps.view.scanFailed"));
  const vaultByFolder = useMemo(() => new Map(vault.map((map) => [map.folderName.toLocaleLowerCase(), map])), [vault]);

  useEffect(() => {
    const maps = useAppStore.getState().state.maps;
    if (maps.installedStatus.type === "idle") loadInstalled();
    if (maps.vaultStatus.type === "idle") loadVault();
  }, []);

  const choosePreset = (next: InstalledPreset) => {
    setPreset(next);
    if (next === "all") setSort("name");
  };

  const hiddenFilterCount = Number(ranked !== "all")
    + Number(minimumRating !== null || maximumRating !== null)
    + Number(minimumPlayers !== null || maximumPlayers !== null)
    + Number(width !== 0 || height !== 0);

  const clearSearch = () => {
    setSearch("");
    setAuthor("");
    setPreset("all");
    setSort("name");
    setRanked("all");
    setMinimumRating(null);
    setMaximumRating(null);
    setMinimumPlayers(null);
    setMaximumPlayers(null);
    setWidth(0);
    setHeight(0);
    setPage(1);
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const authorQuery = author.trim().toLocaleLowerCase();
    return installed
      .filter((map) => {
        const meta = vaultByFolder.get(map.folderName.toLocaleLowerCase());
        const isFav = favoriteFolders.has(map.folderName.toLocaleLowerCase());
        const isOfficial = isOfficialMap(map.folderName);
        const isRankedMap = meta?.ranked ?? false;

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
        const metaLeft = vaultByFolder.get(left.folderName.toLocaleLowerCase());
        const metaRight = vaultByFolder.get(right.folderName.toLocaleLowerCase());
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
        }
      });
  }, [
    installed, search, author, preset, sort, ranked, minimumRating, maximumRating,
    minimumPlayers, maximumPlayers, width, height, vaultByFolder, favoriteFolders,
  ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageMaps = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

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
              ["custom", "Custom"],
              ["builtin", "Built-in"],
            ] as Array<[InstalledPreset, string]>).map(([key, label]) => (
              <Button
                key={key}
                className={preset === key ? "active" : ""}
                onClick={() => choosePreset(key)}
                title={key === "favorites" ? `Show ${favoriteFolders.size} favorited maps` : undefined}
              >
                {key === "favorites" && <Icon name="star" size={14} fill="currentColor" />} {label}
              </Button>
            ))}
            <span className="spacer" />
            <SearchPanelToggle expanded={filtersOpen} count={hiddenFilterCount} onClick={() => setFiltersOpen((open) => !open)} />
            <Button onClick={clearSearch}>{t("maps.view.clear")}</Button>
            <Button onClick={loadInstalled} disabled={installedStatus.type === "loading"}>
              <Icon name="refresh" size={15} /> {t("maps.view.rescan")}
            </Button>
          </>
        )}
        advanced={filtersOpen ? (
          <div className="search-panel-advanced">
            <div className="search-panel-advanced-grid">
              <SearchField label={t("maps.view.width")}>
                <select className="search-panel-control" value={width} onChange={(event) => setWidth(Number(event.target.value))}>
                  <option value={0}>{t("maps.view.any")}</option>
                  {MAP_SIZES.map((value) => <option key={value} value={value}>{(value / 51.2).toFixed(0)} km</option>)}
                </select>
              </SearchField>
              <SearchField label={t("maps.view.height")}>
                <select className="search-panel-control" value={height} onChange={(event) => setHeight(Number(event.target.value))}>
                  <option value={0}>{t("maps.view.any")}</option>
                  {MAP_SIZES.map((value) => <option key={value} value={value}>{(value / 51.2).toFixed(0)} km</option>)}
                </select>
              </SearchField>
            </div>
          </div>
        ) : undefined}
      >
        <SearchField label={t("maps.view.map")} className="search-panel-field-grow map-search-query">
          <input
            className="search-panel-control"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
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
              setAuthor(event.target.value);
              setPage(1);
            }}
            placeholder={t("maps.view.anyAuthor")}
          />
        </SearchField>
        <RangeSlider
          label={t("maps.view.reviewScore")}
          min={0}
          max={5}
          step={0.5}
          low={minimumRating}
          high={maximumRating}
          format={(value) => `${value}★`}
          onChange={(low, high) => { setMinimumRating(low); setMaximumRating(high); setPage(1); }}
        />
        <RangeSlider
          label={t("maps.view.playerSlots")}
          min={1}
          max={16}
          step={1}
          low={minimumPlayers}
          high={maximumPlayers}
          format={(value) => `${value}`}
          onChange={(low, high) => { setMinimumPlayers(low); setMaximumPlayers(high); setPage(1); }}
        />
        <SearchField label={t("maps.view.ranking")} className="search-panel-field-compact">
          <select className="search-panel-control" value={ranked} onChange={(event) => { setRanked(event.target.value as RankedFilter); setPage(1); }}>
            <option value="all">{t("maps.view.any")}</option>
            <option value="ranked">{t("maps.view.ranked")}</option>
            <option value="unranked">{t("maps.view.unranked")}</option>
          </select>
        </SearchField>
        <SearchField label={t("maps.view.sortBy")} className="search-panel-field-compact">
          <select className="search-panel-control" value={sort} onChange={(event) => setSort(event.target.value as InstalledSort)}>
            <option value="name">{t("maps.view.sort.name")}</option>
            <option value="size">{t("maps.view.sort.size")}</option>
            <option value="players">Players</option>
            <option value="rating">{t("maps.view.preset.rating")}</option>
            <option value="newest">{t("maps.view.preset.newest")}</option>
          </select>
        </SearchField>
      </SearchPanel>

      {note && <p className="vault-note muted">{note}</p>}
      {installedStatus.type === "ready" && filtered.length === 0 ? (
        <EmptyState
          bordered
          icon={installed.length === 0 ? "maps" : "search"}
          title={t(installed.length === 0 ? "maps.view.noneInstalled" : "maps.view.noInstalledMatch")}
          hint={t(installed.length === 0 ? "maps.view.noneInstalledHint" : "maps.view.noInstalledMatchHint")}
        />
      ) : filtered.length > 0 && (
        <section className="installed-map-library">
          <div className="vault-results-head">
            <span>{t("maps.view.installedCount", { count: filtered.length })}</span>
            <span>{t("maps.view.userMapsFolder")}</span>
          </div>
          <div className="installed-map-grid">
            {pageMaps.map((map) => {
              const metadata = vaultByFolder.get(map.folderName.toLocaleLowerCase());
              const isBusy = busy && installStatus.type === "installing" && installStatus.payload.folderName === map.folderName;
              return (
                <article className="installed-map-card surface-panel" key={map.folderName}>
                  <MapPreview map={metadata ?? map} />
                  <span>
                    <strong>{metadata?.displayName || map.displayName}</strong>
                    <small>{map.folderName}</small>
                    <small>
                      {sizeLabel(metadata ?? { width: map.width ?? 512, height: map.height ?? 512 })} · {map.maxPlayers ?? metadata?.maxPlayers ?? 2} players
                      {metadata && metadata.reviews > 0 && ` · ${ratingLabel(metadata)}`}
                    </small>
                  </span>
                  <span className="installed-map-actions">
                    <Button
                      className="map-vault-uninstall"
                      disabled={isBusy}
                      onClick={() => setPendingUninstall(map)}
                    >
                      {t(isBusy ? "maps.view.removing" : "maps.view.uninstall")}
                    </Button>
                  </span>
                </article>
              );
            })}
          </div>
          {totalPages > 1 && (
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          )}
        </section>
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

const SUB_VIEWS: Record<SubView, { label: MessageKey; Component: (props: { busy: boolean }) => JSX.Element }> = {
  vault: { label: "maps.view.tab.vault", Component: VaultView },
  installed: { label: "maps.view.tab.installed", Component: InstalledView },
};

const cleanUpGeneratedMaps = () =>
  ipc.send({ kind: "MapGenerator", command: { type: "cleanUp" } });

export function MapsView() {
  const { t } = useTranslation();
  const [subView, setSubView] = useState<SubView>("vault");
  const [generating, setGenerating] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const installed = useAppStore((state) => state.state.maps.installed);
  const installStatus = useAppStore((state) => state.state.maps.installStatus);
  const generatorStatus = useAppStore((state) => state.state.mapGenerator.status);
  const note = installNote(installStatus);
  const busy = installStatus.type === "installing";
  const { Component } = SUB_VIEWS[subView];

  return (
    <div className="maps-workspace">
      {note && <div className="vault-note muted">{note}</div>}
      <div className="vault-subnav">
        <SectionTabs
          active={subView}
          ariaLabel={t("maps.view.mapLibraryViews")}
          items={(Object.keys(SUB_VIEWS) as SubView[]).map((key) => ({ id: key, label: t(SUB_VIEWS[key].label) }))}
          onChange={setSubView}
        />
        <div className="vault-subnav-actions">
          <Button variant="ghost" onClick={() => setUploadModalOpen(true)}>
            <Icon name="upload" size={15} /> {t("uploads.title.map")}
          </Button>
          {subView === "installed" && (
            <>
              {/* Generated maps are reproducible from their name, so removing them
                  costs nothing but reclaims the disk a season of ladder accumulates. */}
              <Button onClick={cleanUpGeneratedMaps}>{t("maps.view.clearGenerated")}</Button>
              <Button variant="primary" onClick={() => setGenerating(true)}>
                <Icon name="plus" size={15} /> {t("maps.view.generateMap")}
              </Button>
            </>
          )}
        </div>
      </div>
      <Component busy={busy} />
      {generating && <GenerateMapModal onClose={() => setGenerating(false)} />}
      {uploadModalOpen && (
        <MapUploadModal
          installed={installed}
          onClose={() => setUploadModalOpen(false)}
        />
      )}
      {/* Progress stays visible after the dialog closes: a run started here
          keeps going, and it is slow enough that the user will navigate away. */}
      {!generating && stillRunning(generatorStatus) && (
        <div className="maps-generator-status surface"><GeneratorProgress /></div>
      )}
    </div>
  );
}
