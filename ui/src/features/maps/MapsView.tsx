// Maps tab: vault discovery and installed-map management. The backend owns
// the map catalogue and installation state; this component only derives the
// current search, filters, sorting and selection for presentation.

import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { SectionTabs } from "../../design-system/SectionTabs";
import { RangeSlider } from "../../design-system/RangeSlider";
import {
  SearchField,
  SearchPanel,
  SearchPanelSubmit,
  SearchPanelToggle,
} from "../../design-system/SearchPanel";
import { openUpload } from "../uploads/UploadDialog";
import { Modal } from "../../design-system/Modal";
import type { InstalledMap, VaultMap } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { loadStatusNote } from "../../shared/loadStatusNote";
import { includesNormalized, isWithinDateRange, isWithinNumberRange } from "../../shared/filterRanges";
import { useAppStore } from "../../store/store";
import {
  installNote,
  MapCard,
  MapDetailPanel,
  mapInstalled,
  MapPreview,
  MapUninstallDialog,
  sizeLabel,
} from "./MapVaultComponents";
import { GenerateMapModal, GeneratorProgress } from "./GenerateMapModal";
import "./maps.css";

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

function VaultView({ busy }: { busy: boolean }) {
  const vault = useAppStore((state) => state.state.maps.vault);
  const vaultStatus = useAppStore((state) => state.state.maps.vaultStatus);
  const installed = useAppStore((state) => state.state.maps.installed);
  const installedStatus = useAppStore((state) => state.state.maps.installedStatus);
  const installStatus = useAppStore((state) => state.state.maps.installStatus);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  const [search, setSearch] = useState("");
  const [preset, setPreset] = useState<VaultPreset>("recommended");
  const [sort, setSort] = useState<VaultSort>("rating");
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
  const note = loadStatusNote(vaultStatus, "Loading map vault…", "Could not load map vault");
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

  useEffect(() => setPage(1), [
    search, preset, sort, ranked, installFilter, author, createdAfter, createdBefore, browsing.favoriteMaps,
    minimumRating, maximumRating, minimumPlayers, maximumPlayers, width, height,
  ]);

  const choosePreset = (next: VaultPreset) => {
    setPreset(next);
    if (next === "rating" || next === "recommended") setSort("rating");
    if (next === "newest") setSort("newest");
    if (next === "played") setSort("played");
    if (next === "favorites") setSort("rating");
    if (next === "all") setSort("name");
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return vault
      .filter((map) => preset !== "recommended" || map.recommended)
      .filter((map) => preset !== "favorites" || favoriteFolders.has(map.folderName.toLocaleLowerCase()))
      .filter((map) => ranked === "all" || map.ranked === (ranked === "ranked"))
      .filter((map) => includesNormalized(map.author, author))
      .filter((map) => isWithinDateRange(map.createdAt, createdAfter, createdBefore))
      .filter((map) => isWithinNumberRange(map.ratingTenths / 10, minimumRating, maximumRating))
      .filter((map) => isWithinNumberRange(map.maxPlayers, minimumPlayers, maximumPlayers))
      .filter((map) => width === 0 || map.width === width)
      .filter((map) => height === 0 || map.height === height)
      .filter((map) => {
        const isInstalled = mapInstalled(map, installedFolders);
        return installFilter === "all" || isInstalled === (installFilter === "installed");
      })
      .filter((map) => !query || [map.displayName, map.author ?? "", map.folderName, map.description, map.mapType]
        .some((value) => value.toLocaleLowerCase().includes(query)))
      .slice()
      .sort((left, right) => {
        switch (sort) {
          case "rating": return right.ratingTenths - left.ratingTenths || right.reviews - left.reviews;
          case "newest": return (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0);
          case "played": return right.gamesPlayed - left.gamesPlayed;
          case "size": return right.width * right.height - left.width * left.height;
          case "name": return left.displayName.localeCompare(right.displayName);
        }
      });
  }, [
    vault, preset, favoriteFolders, ranked, author, createdAfter, createdBefore, minimumRating, maximumRating,
    minimumPlayers, maximumPlayers, width, height, installFilter, installedFolders, search, sort,
  ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageMaps = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selected = pageMaps.find((map) => map.folderName === selectedFolder) ?? pageMaps[0] ?? null;
  const hiddenFilterCount = Number(installFilter !== "all")
    + Number(createdAfter !== "" || createdBefore !== "")
    + Number(width > 0)
    + Number(height > 0);

  const resetFilters = () => {
    setRanked("all");
    setInstallFilter("all");
    setAuthor("");
    setCreatedAfter("");
    setCreatedBefore("");
    setMinimumRating(null);
    setMaximumRating(null);
    setMinimumPlayers(null);
    setMaximumPlayers(null);
    setWidth(0);
    setHeight(0);
  };

  const clearSearch = () => {
    setSearch("");
    setPreset("recommended");
    setSort("rating");
    resetFilters();
  };

  return (
    <>
      <SearchPanel
        className="map-search-panel"
        onSubmit={(event) => { event.preventDefault(); setPage(1); }}
        secondary={(
          <>
            {([
              ["recommended", "Featured"],
              ["favorites", "Favorites"],
              ["rating", "Highest rated"],
              ["newest", "Most recent"],
              ["played", "Most played"],
              ["all", "All maps"],
            ] as Array<[VaultPreset, string]>).map(([key, label]) => (
            <Button key={key} className={preset === key ? "active" : ""} onClick={() => choosePreset(key)} title={key === "favorites" ? `Show ${favoriteFolders.size} favorited maps` : undefined}>
              {key === "favorites" && <Icon name="star" size={14} fill="currentColor" />} {label}
            </Button>
            ))}
            <span className="spacer" />
            <SearchPanelToggle expanded={filtersOpen} count={hiddenFilterCount} onClick={() => setFiltersOpen((open) => !open)} />
            <Button onClick={clearSearch}>Clear</Button>
            <Button onClick={loadVault} disabled={vaultStatus.type === "loading"}><Icon name="refresh" size={15} /> Refresh</Button>
          </>
        )}
        advanced={filtersOpen ? (
          <div className="search-panel-advanced">
            <div className="search-panel-advanced-grid">
              <SearchField label="Installation"><select className="search-panel-control" value={installFilter} onChange={(event) => setInstallFilter(event.target.value as InstallFilter)}><option value="all">Any</option><option value="installed">Installed</option><option value="available">Not installed</option></select></SearchField>
              <SearchField label="Uploaded after"><input className="search-panel-control" type="date" value={createdAfter} onChange={(event) => setCreatedAfter(event.target.value)} /></SearchField>
              <SearchField label="Uploaded before"><input className="search-panel-control" type="date" value={createdBefore} onChange={(event) => setCreatedBefore(event.target.value)} /></SearchField>
              <SearchField label="Width"><select className="search-panel-control" value={width} onChange={(event) => setWidth(Number(event.target.value))}><option value={0}>Any</option>{MAP_SIZES.map((value) => <option key={value} value={value}>{(value / 51.2).toFixed(0)} km</option>)}</select></SearchField>
              <SearchField label="Height"><select className="search-panel-control" value={height} onChange={(event) => setHeight(Number(event.target.value))}><option value={0}>Any</option>{MAP_SIZES.map((value) => <option key={value} value={value}>{(value / 51.2).toFixed(0)} km</option>)}</select></SearchField>
            </div>
          </div>
        ) : undefined}
      >
        <SearchField label="Map" className="search-panel-field-grow map-search-query">
          <input className="search-panel-control" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, description, or folder" />
        </SearchField>
        <SearchField label="Author" className="search-panel-field-grow map-search-author">
          <input className="search-panel-control" value={author} onChange={(event) => setAuthor(event.target.value)} placeholder="Any author" />
        </SearchField>
        <RangeSlider
          label="Review score"
          min={0}
          max={5}
          step={0.5}
          low={minimumRating}
          high={maximumRating}
          format={(value) => `${value}★`}
          onChange={(low, high) => { setMinimumRating(low); setMaximumRating(high); }}
        />
        <RangeSlider
          label="Player slots"
          min={1}
          max={16}
          low={minimumPlayers}
          high={maximumPlayers}
          onChange={(low, high) => { setMinimumPlayers(low); setMaximumPlayers(high); }}
        />
        <SearchField label="Ranking" className="search-panel-field-compact">
          <select className="search-panel-control" value={ranked} onChange={(event) => setRanked(event.target.value as RankedFilter)}><option value="all">Any</option><option value="ranked">Ranked</option><option value="unranked">Unranked</option></select>
        </SearchField>
        <SearchField label="Sort by" className="search-panel-field-compact">
          <select className="search-panel-control" value={sort} onChange={(event) => { setSort(event.target.value as VaultSort); setPreset("all"); }}><option value="rating">Highest rated</option><option value="newest">Most recent</option><option value="played">Most played</option><option value="name">Name</option><option value="size">Largest</option></select>
        </SearchField>
        <SearchPanelSubmit />
      </SearchPanel>

      {note && <p className="vault-note muted">{note}</p>}
      {installedStatus.type === "failed" && <p className="vault-note muted">Installed-state detection is unavailable.</p>}
      {vaultStatus.type === "ready" && filtered.length === 0 ? (
        <div className="vault-empty"><Icon name={vault.length === 0 ? "maps" : "search"} size={24} /><h3>{vault.length === 0 ? "No maps available" : "No maps match"}</h3><p>{vault.length === 0 ? "Refresh the vault when the FAF API is available." : "Try a broader search or reset the filters."}</p></div>
      ) : pageMaps.length > 0 && (
        <div className="vault-layout">
          <section className="vault-browser">
            <div className="vault-results-head"><span>{filtered.length} {filtered.length === 1 ? "map" : "maps"}</span><span>Page {currentPage} of {totalPages}</span></div>
            <div className="map-vault-grid">
              {pageMaps.map((map) => {
                const isInstalled = mapInstalled(map, installedFolders);
                const isBusy = busy && installStatus.type === "installing" && installStatus.payload.folderName === map.folderName;
                const favorite = favoriteFolders.has(map.folderName.toLocaleLowerCase());
                return <MapCard key={map.folderName} map={map} active={selected?.folderName === map.folderName} installed={isInstalled} busy={isBusy} favorite={favorite} onSelect={() => setSelectedFolder(map.folderName)} onInstall={() => installMap(map.folderName, map.downloadUrl)} onToggleFavorite={() => toggleFavorite(map.folderName)} />;
              })}
            </div>
            {totalPages > 1 && <div className="vault-pagination"><Button disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</Button><span>{currentPage} / {totalPages}</span><Button disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>Next</Button></div>}
          </section>
          {selected && <MapDetailPanel map={selected} installed={mapInstalled(selected, installedFolders)} busy={busy && installStatus.type === "installing" && installStatus.payload.folderName === selected.folderName} favorite={favoriteFolders.has(selected.folderName.toLocaleLowerCase())} onInstall={() => installMap(selected.folderName, selected.downloadUrl)} onUninstall={() => setPendingUninstall(selected)} onPreview={() => setPreviewMap(selected)} onToggleFavorite={() => toggleFavorite(selected.folderName)} />}
        </div>
      )}

      {pendingUninstall && <MapUninstallDialog mapName={pendingUninstall.displayName} onCancel={() => setPendingUninstall(null)} onConfirm={() => { uninstallMap(pendingUninstall.folderName); setPendingUninstall(null); }} />}
      {previewMap && <Modal onClose={() => setPreviewMap(null)}><div className="map-preview-dialog"><h2>{previewMap.displayName}</h2><MapPreview map={previewMap} large /><p>{sizeLabel(previewMap)} · {previewMap.maxPlayers} players</p></div></Modal>}
    </>
  );
}

function InstalledView({ busy }: { busy: boolean }) {
  const installed = useAppStore((state) => state.state.maps.installed);
  const installedStatus = useAppStore((state) => state.state.maps.installedStatus);
  const vault = useAppStore((state) => state.state.maps.vault);
  const installStatus = useAppStore((state) => state.state.maps.installStatus);
  const [search, setSearch] = useState("");
  const [pendingUninstall, setPendingUninstall] = useState<InstalledMap | null>(null);
  const note = loadStatusNote(installedStatus, "Scanning maps folder…", "Could not scan maps folder");
  const vaultByFolder = useMemo(() => new Map(vault.map((map) => [map.folderName.toLocaleLowerCase(), map])), [vault]);
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return installed
      .filter((map) => !query || map.displayName.toLocaleLowerCase().includes(query) || map.folderName.toLocaleLowerCase().includes(query))
      .slice()
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [installed, search]);

  useEffect(() => {
    const maps = useAppStore.getState().state.maps;
    if (maps.installedStatus.type === "idle") loadInstalled();
    if (maps.vaultStatus.type === "idle") loadVault();
  }, []);

  return (
    <>
      <div className="vault-toolbar">
        <label className="search-field vault-search-field"><Icon name="search" size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search installed maps" /></label>
        <Button onClick={loadInstalled} disabled={installedStatus.type === "loading"}><Icon name="refresh" size={15} /> Rescan</Button>
      </div>
      {note && <p className="vault-note muted">{note}</p>}
      {installedStatus.type === "ready" && filtered.length === 0 ? (
        <div className="vault-empty"><Icon name={installed.length === 0 ? "maps" : "search"} size={24} /><h3>{installed.length === 0 ? "No user maps installed" : "No installed maps match"}</h3><p>{installed.length === 0 ? "Install a community map from the vault to see it here." : "Try a broader search."}</p></div>
      ) : filtered.length > 0 && (
        <section className="installed-map-library">
          <div className="vault-results-head"><span>{filtered.length} installed {filtered.length === 1 ? "map" : "maps"}</span><span>User maps folder</span></div>
          <div className="installed-map-grid">
            {filtered.map((map) => {
              const metadata = vaultByFolder.get(map.folderName.toLocaleLowerCase());
              const isBusy = busy && installStatus.type === "installing" && installStatus.payload.folderName === map.folderName;
              return (
                <article className="installed-map-card surface-panel" key={map.folderName}>
                  {metadata ? <MapPreview map={metadata} /> : <span className="map-vault-thumb map-vault-preview-empty" aria-hidden="true"><Icon name="maps" size={24} /></span>}
                  <span><strong>{metadata?.displayName || map.displayName}</strong><small>{map.folderName}</small>{metadata && <small>{sizeLabel(metadata)} · {metadata.maxPlayers} players</small>}</span>
                  <span className="installed-map-actions">
                    <Button disabled={isBusy} onClick={() => openUpload("map", map.folderName, metadata?.displayName || map.displayName)}>Publish</Button>
                    <Button className="map-vault-uninstall" disabled={isBusy} onClick={() => setPendingUninstall(map)}>{isBusy ? "Removing…" : "Uninstall"}</Button>
                  </span>
                </article>
              );
            })}
          </div>
        </section>
      )}
      {pendingUninstall && <MapUninstallDialog mapName={pendingUninstall.displayName} onCancel={() => setPendingUninstall(null)} onConfirm={() => { uninstallMap(pendingUninstall.folderName); setPendingUninstall(null); }} />}
    </>
  );
}

const SUB_VIEWS: Record<SubView, { label: string; Component: (props: { busy: boolean }) => JSX.Element }> = {
  vault: { label: "Vault", Component: VaultView },
  installed: { label: "Installed", Component: InstalledView },
};

const cleanUpGeneratedMaps = () =>
  ipc.send({ kind: "MapGenerator", command: { type: "cleanUp" } });

export function MapsView() {
  const [subView, setSubView] = useState<SubView>("vault");
  const [generating, setGenerating] = useState(false);
  const installStatus = useAppStore((state) => state.state.maps.installStatus);
  const generatorBusy = useAppStore((state) => state.state.mapGenerator.status.type);
  const note = installNote(installStatus);
  const busy = installStatus.type === "installing";
  const { Component } = SUB_VIEWS[subView];

  return (
    <div className="maps-workspace">
      {note && <div className="vault-note muted">{note}</div>}
      <div className="vault-subnav">
        <SectionTabs
          active={subView}
          ariaLabel="Map library views"
          items={(Object.keys(SUB_VIEWS) as SubView[]).map((key) => ({ id: key, label: SUB_VIEWS[key].label }))}
          onChange={setSubView}
        />
        {subView === "installed" && (
          <>
            {/* Generated maps are reproducible from their name, so removing them
                costs nothing but reclaims the disk a season of ladder accumulates. */}
            <Button onClick={cleanUpGeneratedMaps}>Clear generated</Button>
            <Button variant="primary" onClick={() => setGenerating(true)}>
              <Icon name="plus" size={15} /> Generate map
            </Button>
          </>
        )}
      </div>
      <Component busy={busy} />
      {generating && <GenerateMapModal onClose={() => setGenerating(false)} />}
      {/* Progress stays visible after the dialog closes: a run started here
          keeps going, and it is slow enough that the user will navigate away. */}
      {!generating && generatorBusy !== "idle" && (
        <div className="maps-generator-status surface"><GeneratorProgress /></div>
      )}
    </div>
  );
}
