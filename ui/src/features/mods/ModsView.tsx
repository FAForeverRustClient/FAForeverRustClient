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
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { isWithinDateRange, isWithinNumberRange, sortByDateDesc } from "../../shared/filterRanges";
import { loadStatusNote } from "../../shared/loadStatusNote";
import { useAppStore } from "../../store/store";
import {
  installNote,
  ModCard,
  ModDetailPanel,
  toggleNote,
  UninstallDialog,
} from "./ModVaultComponents";
import { InstalledModsView } from "./InstalledModsView";
import { ModUploadModal } from "./ModUploadModal";
import "./mods.css";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n";

type SubView = "vault" | "installed";
type ModSort = "rating" | "newest" | "updated" | "name";
type ModTypeFilter = "all" | "ui" | "sim";
type RankedFilter = "all" | "ranked" | "unranked";
type InstallFilter = "all" | "installed" | "available" | "updates";
type ModPreset = "recommended" | "rating" | "ui" | "newest" | "all";
type DateField = "updated" | "uploaded";

const PAGE_SIZE = 36;
const MOD_PRESETS: Array<[ModPreset, MessageKey]> = [
  ["recommended", "mods.view.preset.recommended"],
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

function VaultView({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.mods.vault);
  const vaultStatus = useAppStore((state) => state.state.mods.vaultStatus);
  const installed = useAppStore((state) => state.state.mods.installed);
  const installedStatus = useAppStore((state) => state.state.mods.installedStatus);
  const installStatus = useAppStore((state) => state.state.mods.installStatus);
  const toggleStatus = useAppStore((state) => state.state.mods.toggleStatus);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  const preset = (browsing.modVaultPreset as ModPreset) || "recommended";
  const initialSort: ModSort = (() => {
    if (preset === "newest") return "newest";
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

  useEffect(() => {
    const mods = useAppStore.getState().state.mods;
    if (mods.vaultStatus.type === "idle") loadVault();
    if (mods.installedStatus.type === "idle") loadInstalled();
  }, []);

  useEffect(() => {
    if (preset === "newest") {
      setSort("newest");
      setApplied((prev) => ({ ...prev, sort: "newest" }));
    } else if (preset === "all") {
      setSort("name");
      setApplied((prev) => ({ ...prev, sort: "name" }));
    } else if (preset === "recommended" || preset === "rating" || preset === "ui") {
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

  const choosePreset = (next: ModPreset) => {
    let nextSort: ModSort = sort;
    if (next === "recommended" || next === "rating" || next === "ui") nextSort = "rating";
    if (next === "newest") nextSort = "newest";
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

  const filtered = useMemo(() => {
    const query = applied.search.trim().toLocaleLowerCase();
    const creatorQuery = applied.creator.trim().toLocaleLowerCase();
    const hasDateFilter = Boolean(applied.dateAfter || applied.dateBefore);

    // Single pass; see the same change in `MapsView` for why the `.filter()`
    // chain was worth unpicking.
    const matches: VaultMod[] = [];
    for (const mod of vault) {
      if (preset === "recommended" && !mod.recommended) continue;
      if (preset === "ui" && mod.modType !== "ui") continue;
      if (applied.modType !== "all" && mod.modType !== applied.modType) continue;
      if (applied.ranked !== "all" && mod.ranked !== (applied.ranked === "ranked")) continue;
      if (creatorQuery
        && !mod.author.toLocaleLowerCase().includes(creatorQuery)
        && !mod.uploader.toLocaleLowerCase().includes(creatorQuery)) continue;
      if (hasDateFilter
        && !isWithinDateRange(applied.dateField === "updated" ? mod.updatedAt : mod.createdAt, applied.dateAfter, applied.dateBefore)) continue;
      if (!isWithinNumberRange(mod.ratingTenths / 10, applied.minimumRating, applied.maximumRating)) continue;
      if (applied.installFilter !== "all") {
        const installedMod = installedByUid.get(mod.uid);
        const matchesInstall = applied.installFilter === "installed"
          ? Boolean(installedMod)
          : applied.installFilter === "updates"
            ? Boolean(installedMod && installedMod.version !== mod.version)
            : !installedMod;
        if (!matchesInstall) continue;
      }
      if (query
        && !mod.displayName.toLocaleLowerCase().includes(query)
        && !mod.author.toLocaleLowerCase().includes(query)
        && !mod.uploader.toLocaleLowerCase().includes(query)
        && !mod.description.toLocaleLowerCase().includes(query)
        && !mod.uid.toLocaleLowerCase().includes(query)
        && !mod.filename.toLocaleLowerCase().includes(query)) continue;
      matches.push(mod);
    }

    if (applied.sort === "newest") return sortByDateDesc(matches, (mod) => mod.createdAt);
    if (applied.sort === "updated") return sortByDateDesc(matches, (mod) => mod.updatedAt);
    return matches.sort((left, right) => {
      switch (applied.sort) {
        case "rating": return right.ratingTenths - left.ratingTenths || right.reviews - left.reviews;
        case "name": return left.displayName.localeCompare(right.displayName);
        default: return 0;
      }
    });
  }, [
    vault, preset, applied, installedByUid,
  ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageMods = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
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
            {MOD_PRESETS.map(([key, label]) => (
              <Button key={key} className={preset === key ? "active" : ""} onClick={() => choosePreset(key)}>{t(label)}</Button>
            ))}
            <span className="spacer" />
            <SearchPanelToggle expanded={filtersOpen} count={hiddenFilterCount} onClick={() => setFiltersOpen((open) => !open)} />
            <Button onClick={clearSearch}>{t("mods.view.clear")}</Button>
            <Button onClick={loadVault} disabled={vaultStatus.type === "loading"}><Icon name="refresh" size={15} /> {t("mods.view.refresh")}</Button>
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
          <select className="search-panel-control" value={sort} onChange={(event) => { setSort(event.target.value as ModSort); choosePreset("all"); }}><option value="rating">{t("mods.view.preset.rating")}</option><option value="newest">{t("mods.view.preset.newest")}</option><option value="updated">{t("mods.view.recentlyUpdated")}</option><option value="name">{t("mods.view.name")}</option></select>
        </SearchField>
        <SearchPanelSubmit />
      </SearchPanel>

      {note && <p className="vault-note muted">{note}</p>}
      {installedStatus.type === "failed" && <p className="vault-note muted">{t("mods.view.detectionUnavailable")}</p>}
      {vaultStatus.type === "ready" && filtered.length === 0 ? (
        <EmptyState
          bordered
          icon={vault.length === 0 ? "mods" : "search"}
          title={t(vault.length === 0 ? "mods.view.emptyVault" : "mods.view.noMatch")}
          hint={t(vault.length === 0 ? "mods.view.emptyVaultHint" : "mods.view.noMatchHint")}
        />
      ) : pageMods.length > 0 ? (
        <>
          <div className="vault-results-head">
            <span>{filtered.length} {filtered.length === 1 ? "mod" : "mods"}</span>
            <span>Page {currentPage} of {totalPages}</span>
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
                      busy={busy}
                      working={isBusy}
                      onSelect={() => setSelectedUid(mod.uid)}
                      onInstall={() => installMod(mod.uid, mod.downloadUrl)}
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
                  busy={busy}
                  installing={installing}
                  toggling={toggling}
                  onInstall={() => installMod(selected.uid, selected.downloadUrl)}
                  onToggle={() => installedMod && toggleMod(installedMod.uid, !installedMod.enabled)}
                  onUninstall={() => installedMod && setPendingUninstall(installedMod)}
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
  const note = installNote(installStatus) ?? toggleNote(toggleStatus);
  const busy = installStatus.type === "installing" || toggleStatus.type === "toggling";
  const { Component } = SUB_VIEWS[subView];
  return (
    <div className="mods-workspace">
      {note && <div className="vault-note muted">{note}</div>}
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
