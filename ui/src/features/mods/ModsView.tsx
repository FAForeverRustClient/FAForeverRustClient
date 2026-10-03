// Mods tab: vault discovery plus installed/active-mod management. Rust owns
// the catalogue and filesystem/game.prefs state; this view derives only the
// current search, filters, sorting and selection.

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { SectionTabs, sectionPanelProps } from "../../design-system/SectionTabs";
import { DEFAULT_VAULT_PAGE_SIZE } from "../../shared/browsingPreferences";
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
import type { InstalledMod, ModsSection, ModVaultQuery, VaultMod } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { EMPTY_MOD_QUERY, sameVaultSearch } from "../../shared/vaultQuery";
import { FailureNotice, LoadStatusNotice } from "../../shared/components/LoadNotices";
import { useAppStore } from "../../store/store";
import {
  installNote,
  ModCard,
  ModDetailPanel,
  toggleNote,
  UninstallDialog,
} from "./ModVaultComponents";
import { InstalledModsView } from "./InstalledModsView";
// Two entry points, not two implementations of one: the modal publishes a mod
// that is already installed, and `openUploadFromDisk` takes an archive straight
// off the filesystem, which is what an author has after building one.
import { openUploadFromDisk } from "../uploads/UploadDialog";
import { ModRenameDialog } from "./ModRenameDialog";
import { hasModVaultFocus, requestModVaultFocus, takeModVaultFocus } from "../../shared/modVaultFocus";
import { type ModInstallFilter, modsMatchingQuery, modsPassingInstallFilter } from "./modVaultResults";
import { modCounterparts } from "./modIdentity";
import { StatusNotice } from "../../design-system/StatusNotice";
import { localPage, vaultPageOutcome } from "../../shared/vaultResults";
import { favoriteModKeys, toggleFavoriteMod } from "./favoriteMods";
import "./mods.css";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n";
import { DateInput } from "../../design-system/DateInput";

type SubView = ModsSection;
type ModSort = "rating" | "newest" | "updated" | "name";
type ModTypeFilter = "all" | "ui" | "sim";
type RankedFilter = "all" | "ranked" | "unranked";
type InstallFilter = ModInstallFilter;
type ModPreset = "recommended" | "favorites" | "mine" | "rating" | "ui" | "newest" | "all";
type DateField = "updated" | "uploaded";

const MOD_SORTS: readonly ModSort[] = ["rating", "newest", "updated", "name"];

/** The sort a preset brings with it when nothing else has been chosen. */
function presetSort(preset: ModPreset): ModSort {
  if (preset === "newest" || preset === "mine") return "newest";
  if (preset === "all") return "name";
  return "rating";
}

function storedModSort(value: string): ModSort | null {
  return (MOD_SORTS as readonly string[]).includes(value) ? (value as ModSort) : null;
}
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
const updateMod = (uid: string, folderName: string, downloadUrl: string) => ipc.send({ kind: "Mods", command: { type: "updateMod", payload: { uid, folderName, downloadUrl } } });
const uninstallMod = (folderName: string, uid: string) => ipc.send({ kind: "Mods", command: { type: "uninstallMod", payload: { folderName, uid } } });
const toggleMod = (uid: string, enabled: boolean) => ipc.send({ kind: "Mods", command: { type: "toggleMod", payload: { uid, enabled } } });

/**
 * Where the search box is allowed to match.
 *
 * "name" is the floor, and the reported bug: searching "reui" against the
 * description returned every mod that mentions ReUI in prose, with the mods
 * actually called ReUI somewhere in the middle of them. Prose is still worth
 * searching, so it is a choice in the search panel rather than a default.
 */
type ModSearchScope = "name" | "description" | "exact";

interface ModFilterState {
  search: string;
  searchScope: ModSearchScope;
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
  pageSize: number,
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
    exactName: applied.searchScope === "exact",
    searchDescriptions: applied.searchScope === "description",
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
    pageSize,
  };
}

/**
 * The filter form a query was built from, read back from the query.
 *
 * Tabs are unmounted when they lose focus, so a form kept only in this view
 * was empty again every time the reader came back. The last query the backend
 * ran (`state.mods.browseQuery`) outlives the view, as the replay tab's
 * `vaultQuery` does, so the form is seeded from it. `null` when nothing has
 * been searched this session, which leaves the defaults in place.
 *
 * The install filter is not part of the query (it is applied to the page in
 * the client), so it starts at "all" again.
 */
function modFilterFromQuery(query: ModVaultQuery, preset: ModPreset): ModFilterState | null {
  if (sameVaultSearch(query, EMPTY_MOD_QUERY) && query.page === EMPTY_MOD_QUERY.page) return null;
  return {
    search: query.search,
    searchScope: query.exactName ? "exact" : query.searchDescriptions ? "description" : "name",
    creator: query.author,
    sort: query.sortBy,
    // The `ui` preset is sent as a type filter; it is the preset's, not the form's.
    modType: preset === "ui" || (query.modType !== "ui" && query.modType !== "sim") ? "all" : query.modType,
    ranked: query.ranked === null ? "all" : query.ranked ? "ranked" : "unranked",
    installFilter: "all",
    dateField: query.dateFieldUpdated ? "updated" : "uploaded",
    dateAfter: query.after,
    dateBefore: query.before,
    minimumRating: query.minRatingTenths === null ? null : query.minRatingTenths / 10,
    maximumRating: query.maxRatingTenths === null ? null : query.maxRatingTenths / 10,
  };
}

function VaultView({ busy }: { busy: boolean }) {
  // The Upload button opens this first. Pressing it used to put an OS
  // file browser on screen immediately, which for anyone streaming is
  // their filesystem in front of an audience.
  const { t } = useTranslation();
  const vault = useAppStore((state) => state.state.mods.vault);
  const vaultStatus = useAppStore((state) => state.state.mods.vaultStatus);
  const browse = useAppStore((state) => state.state.mods.browse);
  const browseStatus = useAppStore((state) => state.state.mods.browseStatus);
  const browseTotalPages = useAppStore((state) => state.state.mods.browseTotalPages);
  // The query the page count in state was reported for. See `sameVaultSearch`.
  const browseQuery = useAppStore((state) => state.state.mods.browseQuery);
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
  // The sort survives leaving the tab. See the twin in MapsView for why.
  const initialSort: ModSort = storedModSort(browsing.modVaultSort) ?? presetSort(preset);
  const pageSize = browsing.vaultPageSize || DEFAULT_VAULT_PAGE_SIZE;
  // What was last searched, read once as the tab mounts: the form starts from
  // it, so coming back from another tab finds the search where it was left.
  const [restored] = useState(() => modFilterFromQuery(browseQuery, preset));
  const [search, setSearch] = useState(restored?.search ?? "");
  const [searchScope, setSearchScope] = useState<ModSearchScope>(restored?.searchScope ?? "name");
  const [sort, setSort] = useState<ModSort>(restored?.sort ?? initialSort);
  const [modType, setModType] = useState<ModTypeFilter>(restored?.modType ?? "all");
  const [ranked, setRanked] = useState<RankedFilter>(restored?.ranked ?? "all");
  const [installFilter, setInstallFilter] = useState<InstallFilter>("all");
  const [creator, setCreator] = useState(restored?.creator ?? "");
  const [dateField, setDateField] = useState<DateField>(restored?.dateField ?? "updated");
  const [dateAfter, setDateAfter] = useState(restored?.dateAfter ?? "");
  const [dateBefore, setDateBefore] = useState(restored?.dateBefore ?? "");
  const [minimumRating, setMinimumRating] = useState<number | null>(restored?.minimumRating ?? null);
  const [maximumRating, setMaximumRating] = useState<number | null>(restored?.maximumRating ?? null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(restored ? browseQuery.page : 1);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledMod | null>(null);
  const [renaming, setRenaming] = useState<VaultMod | null>(null);

  const [applied, setApplied] = useState<ModFilterState>(restored ?? {
    search: "",
    searchScope: "name",
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

  // Someone clicked a mod somewhere else and was sent here to look at it. Only
  // on mount: tabs are unmounted when they lose focus, so this runs exactly
  // once per visit, and the request is cleared as it is read.
  useEffect(() => {
    const focused = takeModVaultFocus();
    if (!focused) return;
    setSearch(focused);
    setApplied((prev) => ({ ...prev, search: focused }));
    setPage(1);
    // The recommended preset ignores the search box, exactly as typing in it
    // does elsewhere in this view.
    if (preset === "recommended") choosePreset("all");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A vault card is the mod's latest version and an installed copy may be an
  // older one, so the two are not matched by uid alone: see `modIdentity`.
  const { installedFor } = useMemo(() => modCounterparts(installed, vault), [installed, vault]);
  // Shared with the installed list, which stars the same mods into the same
  // preference: one spelling of a uid counts as the same mod in both.
  const favoriteUids = useMemo(() => favoriteModKeys(browsing.favoriteMods), [browsing.favoriteMods]);
  const toggleFavorite = (uid: string) => toggleFavoriteMod(browsing, uid);

  // The vault once per session (the service refuses a repeat); the installed
  // list on every visit, because the folder changes under the client.
  useEffect(() => {
    loadVault();
    loadInstalled();
  }, []);

  // Only on a change of preset, never on mount, so the remembered sort is not
  // overwritten the moment the tab comes back.
  //
  // "My mods" has no ranking of its own worth defaulting to, and newest first
  // is what an uploader wants: the release they just pushed.
  const lastPreset = useRef(preset);
  useEffect(() => {
    if (lastPreset.current === preset) return;
    lastPreset.current = preset;
    const next = presetSort(preset);
    setSort(next);
    setApplied((prev) => ({ ...prev, sort: next }));
  }, [preset]);

  const applySearch = () => {
    setApplied({
      search,
      searchScope,
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
    if (browsing.modVaultSort !== nextSort) {
      ipc.send({
        kind: "Settings",
        command: {
          type: "setBrowsing",
          payload: { preferences: { ...browsing, modVaultSort: nextSort } },
        },
      });
    }
  };

  const choosePreset = (next: ModPreset) => {
    let nextSort: ModSort = sort;
    if (next === "recommended" || next === "rating" || next === "ui" || next === "favorites") nextSort = "rating";
    if (next === "newest" || next === "mine") nextSort = "newest";
    if (next === "all") nextSort = "name";
    setSort(nextSort);
    setApplied((prev) => ({ ...prev, sort: nextSort }));
    setPage(1);
    if (browsing.modVaultPreset !== next || browsing.modVaultSort !== "") {
      ipc.send({
        kind: "Settings",
        command: {
          type: "setBrowsing",
          // A preset brings its own order, so choosing one clears the
          // remembered sort rather than fighting it on the next load.
          payload: { preferences: { ...browsing, modVaultPreset: next, modVaultSort: "" } },
        },
      });
    }
  };

  const clearSearch = () => {
    setSearch("");
    setSearchScope("name");
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
      searchScope: "name",
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
    () => modVaultQuery(applied, preset, page, playerId, pageSize),
    [applied, preset, page, playerId, pageSize],
  );

  useEffect(() => {
    if (localFavorites) return;
    ipc.send({ kind: "Mods", command: { type: "searchVault", payload: { query } } });
  }, [localFavorites, query]);

  // The query the server would have been sent, answered from the index: the
  // search, creator, type, ranking, ratings, dates and sort apply here too,
  // where they used to be shown and then ignored.
  const favorites = useMemo(
    () => (localFavorites
      ? modsMatchingQuery(vault.filter((mod) => favoriteUids.has(mod.uid.toLocaleLowerCase())), query)
      : []),
    [localFavorites, vault, favoriteUids, query],
  );

  // The install filter is local knowledge, so it is applied here: to one
  // server page, or to the whole favourites list before that is paged.
  const results = useMemo(
    () => modsPassingInstallFilter(localFavorites ? favorites : browse, applied.installFilter, installedFor),
    [applied.installFilter, browse, favorites, installedFor, localFavorites],
  );

  // Same rule as the Maps tab: the count in state describes the search it came
  // back with, not the one whose results are still on their way. Favourites
  // count what is left after every filter, not the starred total.
  const favoritePage = localPage(results, page, pageSize);
  const totalPages = localFavorites
    ? favoritePage.totalPages
    : (sameVaultSearch(browseQuery, query) ? browseTotalPages ?? 1 : 1);
  const currentPage = localFavorites ? favoritePage.currentPage : Math.min(page, totalPages);
  const pageMods = localFavorites ? favoritePage.items : results;
  // A page the install filter emptied is not a search that found nothing:
  // see `vaultPageOutcome`.
  const outcome = vaultPageOutcome({
    settled: localFavorites ? vaultStatus.type === "ready" : browseStatus.type === "ready",
    received: localFavorites ? results.length : browse.length,
    shown: pageMods.length,
    currentPage,
    totalPages,
  });
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
              <SearchField label={t("mods.view.after")}><DateInput className="search-panel-control" value={dateAfter} onChange={setDateAfter} /></SearchField>
              <SearchField label={t("mods.view.before")}><DateInput className="search-panel-control" value={dateBefore} onChange={setDateBefore} /></SearchField>
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
            placeholder={t(searchScope === "description"
              ? "mods.view.nameDescriptionUid"
              : "mods.view.anyModName")}
          />
        </SearchField>
        {/* Next to the box it governs, and visible without opening the
            advanced panel: what a search matches is not an advanced question,
            it is the first thing a result set that looks wrong raises. */}
        <SearchField label={t("mods.view.searchIn")} className="search-panel-field-compact">
          <select
            className="search-panel-control"
            title={t("mods.view.searchInHint")}
            value={searchScope}
            onChange={(event) => setSearchScope(event.target.value as ModSearchScope)}
          >
            <option value="name">{t("mods.view.searchIn.name")}</option>
            <option value="description">{t("mods.view.searchIn.description")}</option>
            <option value="exact">{t("mods.view.searchIn.exact")}</option>
          </select>
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
          <select className="search-panel-control" value={modType} onChange={(event) => {
            setModType(event.target.value as ModTypeFilter);
            // Leaving the preset is what stops the `ui` preset, itself a type
            // filter, from overriding the choice. Favourites answer the type
            // locally, so a type chosen there narrows them instead of
            // leaving them.
            if (preset !== "favorites") choosePreset("all");
          }}><option value="all">{t("mods.view.any")}</option><option value="ui">{t("mods.view.uiMods")}</option><option value="sim">{t("mods.view.simMods")}</option></select>
        </SearchField>
        <SearchField label={t("mods.view.ranking")} className="search-panel-field-compact">
          <select className="search-panel-control" value={ranked} onChange={(event) => setRanked(event.target.value as RankedFilter)}><option value="all">{t("mods.view.any")}</option><option value="ranked">{t("mods.view.rankedSafe")}</option><option value="unranked">{t("mods.view.unranked")}</option></select>
        </SearchField>
        <SearchField label={t("mods.view.sortBy")} className="search-panel-field-compact">
          <select className="search-panel-control" value={sort} onChange={(event) => chooseSort(event.target.value as ModSort)}><option value="rating">{t("mods.view.preset.rating")}</option><option value="newest">{t("mods.view.preset.newest")}</option><option value="updated">{t("mods.view.recentlyUpdated")}</option><option value="name">{t("mods.view.name")}</option></select>
        </SearchField>
        <SearchPanelSubmit />
      </SearchPanel>

      <LoadStatusNotice
        status={vaultStatus}
        failed={t("mods.view.vaultFailed")}
        onRetry={loadVault}
      />
      {/* The search this page shows, and what failed: see the same block in
          the map vault for why each was missing. */}
      {!localFavorites && (
        <LoadStatusNotice
          status={browseStatus}
          failed={t("mods.view.searchFailed")}
          onRetry={() => ipc.send({ kind: "Mods", command: { type: "searchVault", payload: { query } } })}
        />
      )}
      <FailureNotice status={installStatus} message={installNote(installStatus)} />
      <FailureNotice status={toggleStatus} message={toggleNote(toggleStatus)} />
      {installedStatus.type === "failed" && <p className="vault-note muted">{t("mods.view.detectionUnavailable")}</p>}
      {outcome.kind === "noMatch" ? (
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
          >
            {vault.length > 0 && <Button onClick={clearSearch}>{t("maps.view.clear")}</Button>}
          </EmptyState>
        )
      ) : outcome.kind !== "waiting" ? (
        <>
          <div className="vault-results-head">
            <span>{t("maps.view.resultCount", { count: pageMods.length })}</span>
            <span>{t("maps.view.pageOf", { page: currentPage, total: totalPages })}</span>
          </div>
          <div
            className={!localFavorites && browseStatus.type === "loading" ? "vault-layout is-stale-results" : "vault-layout"}
            aria-busy={!localFavorites && browseStatus.type === "loading"}
          >
            <section className="vault-browser">
              {/* Every mod on this page fell to the install filter, which only
                  sees this page; the next one may well have some, so the pager
                  stays and the note points there. */}
              {outcome.kind !== "results" ? (
                <StatusNotice
                  tone="info"
                  action={outcome.nextPage === null ? undefined : {
                    label: t("mods.view.nextPage"),
                    onClick: () => setPage(outcome.nextPage ?? currentPage),
                  }}
                >
                  {t(outcome.kind === "filteredOnPage" ? "mods.view.pageFilteredOut" : "mods.view.pageEmpty")}
                </StatusNotice>
              ) : (
              <div className="mod-vault-grid">
                {pageMods.map((mod) => {
                  const installedMod = installedFor(mod);
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
                      onUpdate={() => installedMod && updateMod(mod.uid, installedMod.folderName, mod.downloadUrl)}
                      onUninstall={() => installedMod && setPendingUninstall(installedMod)}
                      onToggleFavorite={() => toggleFavorite(mod.uid)}
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
            {selected && (() => {
              const installedMod = installedFor(selected);
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
                  mine={playerId !== null && selected.uploaderId === playerId}
                  onInstall={() => installMod(selected.uid, selected.downloadUrl)}
                  onUpdate={() => installedMod && updateMod(selected.uid, installedMod.folderName, selected.downloadUrl)}
                  onToggle={() => installedMod && toggleMod(installedMod.uid, !installedMod.enabled)}
                  onUninstall={() => installedMod && setPendingUninstall(installedMod)}
                  onToggleFavorite={() => toggleFavorite(selected.uid)}
                  onRename={() => setRenaming(selected)}
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
      {renaming && installedFor(renaming) && (
        <ModRenameDialog
          mod={renaming}
          installed={installedFor(renaming)!}
          onClose={() => setRenaming(null)}
        />
      )}
    </>
  );
}

const SUB_VIEW_LABELS: Record<SubView, MessageKey> = {
  vault: "mods.view.tab.vault",
  installed: "mods.view.tab.installed",
};

/**
 * The sub-view is the backend's, like the Play tab's mode, so it survives the
 * tab unmounting: coming back to Mods lands on the list that was left, not on
 * the vault every time.
 */
const selectSubView = (section: SubView) =>
  ipc.send({ kind: "Nav", command: { type: "selectModsSection", payload: { section } } });

export function ModsView() {
  const { t } = useTranslation();
  const subView = useAppStore((state) => state.state.nav.modsSection);
  const installStatus = useAppStore((state) => state.state.mods.installStatus);
  const toggleStatus = useAppStore((state) => state.state.mods.toggleStatus);
  const busy = installStatus.type === "installing" || toggleStatus.type === "toggling";

  // A mod clicked in another tab is a request to see it in the vault, but a
  // remembered sub-view may be Installed, where nothing reads the request. So
  // on arrival, switch to the vault if one is waiting. Only looked at, not
  // taken: the vault view is what consumes it, once it has mounted. When the
  // vault is already showing, its own mount effect ran first (children's
  // effects run before their parent's) and there is nothing left to find here.
  useEffect(() => {
    if (useAppStore.getState().state.nav.modsSection === "vault") return;
    if (hasModVaultFocus()) selectSubView("vault");
  }, []);

  // Switching sub-views remounts the one being shown, so the vault view picks
  // the request up in the same mount effect it uses for a jump from another
  // tab: one mechanism, not two.
  const openInVault = (modName: string) => {
    requestModVaultFocus(modName);
    selectSubView("vault");
  };
  return (
    <div className="mods-workspace">
      <div className="vault-subnav">
        <SectionTabs
          active={subView}
          ariaLabel={t("mods.view.modLibraryViews")}
          items={(Object.keys(SUB_VIEW_LABELS) as SubView[]).map((key) => ({ id: key, label: t(SUB_VIEW_LABELS[key]) }))}
          onChange={selectSubView}
          idPrefix="mods-section"
        />
        {/* No publish button here. Uploading a mod is one action with one
            entry point, which is "Upload mod" in the vault's own toolbar. */}
      </div>
      <div {...sectionPanelProps("mods-section", subView)}>
        {subView === "vault" ? (
          <VaultView busy={busy} />
        ) : (
          <InstalledModsView busy={busy} onOpenInVault={openInVault} />
        )}
      </div>
    </div>
  );
}
