import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { EmptyState } from "../../design-system/EmptyState";
import { Pagination } from "../../design-system/Pagination";
import { RangeSlider } from "../../design-system/RangeSlider";
import {
  SearchField,
  SearchPanel,
  SearchPanelToggle,
} from "../../design-system/SearchPanel";
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { includesNormalized, isWithinNumberRange } from "../../shared/filterRanges";
import { loadStatusNote } from "../../shared/loadStatusNote";
import { useAppStore } from "../../store/store";
import { ModPreview, UninstallDialog } from "./ModVaultComponents";
import { useTranslation } from "../../i18n/useTranslation";

type ModTypeFilter = "all" | "ui" | "sim";
type EnabledFilter = "all" | "enabled" | "disabled";
type RankedFilter = "all" | "ranked" | "unranked";
type InstalledModPreset = "all" | "enabled" | "disabled" | "ui" | "sim" | "updates";
type InstalledModSort = "state" | "name" | "rating" | "newest" | "author";

const PAGE_SIZE = 48;

const loadVault = () => ipc.send({ kind: "Mods", command: { type: "loadVault" } });
const loadInstalled = () => ipc.send({ kind: "Mods", command: { type: "loadInstalled" } });
const uninstallMod = (folderName: string, uid: string) =>
  ipc.send({
    kind: "Mods",
    command: { type: "uninstallMod", payload: { folderName, uid } },
  });
const toggleMod = (uid: string, enabled: boolean) =>
  ipc.send({ kind: "Mods", command: { type: "toggleMod", payload: { uid, enabled } } });

interface InstalledModCardProps {
  mod: InstalledMod;
  metadata: VaultMod | undefined;
  busy: boolean;
  installing: boolean;
  toggling: boolean;
  onToggle: () => void;
  onUninstall: () => void;
}

function InstalledModCard({
  mod,
  metadata,
  busy,
  installing,
  toggling,
  onToggle,
  onUninstall,
}: InstalledModCardProps) {
  const { t } = useTranslation();
  return (
    <article className={mod.enabled ? "installed-mod-card surface-panel is-enabled" : "installed-mod-card surface-panel"}>
      {metadata ? (
        <ModPreview mod={metadata} />
      ) : (
        <span className="mod-vault-thumb mod-vault-preview-empty" aria-hidden="true">
          <Icon name="mods" size={25} />
        </span>
      )}
      <span className="installed-mod-copy">
        <strong>{mod.displayName}</strong>
        <small>
          {mod.modType === "ui" ? "UI mod" : "Simulation mod"} · v{mod.version}
          {mod.author ? ` · ${mod.author}` : ""}
        </small>
        <small title={mod.uid}>{mod.uid}</small>
      </span>
      <div className="installed-mod-actions">
        <Button disabled={busy} onClick={onToggle}>
          {t(toggling ? "mods.installed.updating" : mod.enabled ? "mods.installed.disable" : "mods.installed.enable")}
        </Button>
        <Button className="mod-vault-uninstall" disabled={busy} onClick={onUninstall}>
          {t(installing ? "mods.installed.working" : "mods.installed.uninstall")}
        </Button>
      </div>
    </article>
  );
}

export function InstalledModsView({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const installed = useAppStore((state) => state.state.mods.installed);
  const installedStatus = useAppStore((state) => state.state.mods.installedStatus);
  const vault = useAppStore((state) => state.state.mods.vault);
  const installStatus = useAppStore((state) => state.state.mods.installStatus);
  const toggleStatus = useAppStore((state) => state.state.mods.toggleStatus);

  const [search, setSearch] = useState("");
  const [creator, setCreator] = useState("");
  const [preset, setPreset] = useState<InstalledModPreset>("all");
  const [sort, setSort] = useState<InstalledModSort>("state");
  const [modType, setModType] = useState<ModTypeFilter>("all");
  const [enabled, setEnabled] = useState<EnabledFilter>("all");
  const [ranked, setRanked] = useState<RankedFilter>("all");
  const [minimumRating, setMinimumRating] = useState<number | null>(null);
  const [maximumRating, setMaximumRating] = useState<number | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledMod | null>(null);

  const note = loadStatusNote(installedStatus, t("mods.installed.scanning"), t("mods.installed.scanFailed"));
  const vaultByUid = useMemo(() => new Map(vault.map((mod) => [mod.uid, mod])), [vault]);

  useEffect(() => {
    const mods = useAppStore.getState().state.mods;
    if (mods.installedStatus.type === "idle") loadInstalled();
    if (mods.vaultStatus.type === "idle") loadVault();
  }, []);

  const choosePreset = (next: InstalledModPreset) => {
    setPreset(next);
    if (next === "enabled") {
      setEnabled("enabled");
      setModType("all");
    } else if (next === "disabled") {
      setEnabled("disabled");
      setModType("all");
    } else if (next === "ui") {
      setModType("ui");
      setEnabled("all");
    } else if (next === "sim") {
      setModType("sim");
      setEnabled("all");
    } else if (next === "all") {
      setEnabled("all");
      setModType("all");
    }
  };

  const clearSearch = () => {
    setSearch("");
    setCreator("");
    setPreset("all");
    setSort("state");
    setModType("all");
    setEnabled("all");
    setRanked("all");
    setMinimumRating(null);
    setMaximumRating(null);
    setPage(1);
  };

  const updatesCount = useMemo(
    () =>
      installed.filter((m) => {
        const meta = vaultByUid.get(m.uid);
        return meta && meta.version !== m.version;
      }).length,
    [installed, vaultByUid],
  );

  const hiddenFilterCount = Number(ranked !== "all")
    + Number(minimumRating !== null || maximumRating !== null);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const creatorQuery = creator.trim().toLocaleLowerCase();

    return installed
      .filter((mod) => {
        const meta = vaultByUid.get(mod.uid);
        const isRankedMod = meta?.ranked ?? false;
        const hasUpdate = meta && meta.version !== mod.version;

        if (preset === "enabled" && !mod.enabled) return false;
        if (preset === "disabled" && mod.enabled) return false;
        if (preset === "ui" && mod.modType !== "ui") return false;
        if (preset === "sim" && mod.modType !== "sim") return false;
        if (preset === "updates" && !hasUpdate) return false;

        if (modType !== "all" && mod.modType !== modType) return false;
        if (enabled !== "all" && mod.enabled !== (enabled === "enabled")) return false;

        if (ranked === "ranked" && !isRankedMod) return false;
        if (ranked === "unranked" && isRankedMod) return false;

        if (creatorQuery) {
          const authorMatch = includesNormalized(mod.author, creatorQuery)
            || (meta && (includesNormalized(meta.author, creatorQuery) || includesNormalized(meta.uploader, creatorQuery)));
          if (!authorMatch) return false;
        }

        if (minimumRating !== null || maximumRating !== null) {
          if (!meta) return false;
          if (!isWithinNumberRange(meta.ratingTenths / 10, minimumRating, maximumRating)) return false;
        }

        if (query) {
          const matches = [
            mod.displayName,
            mod.author,
            mod.description ?? "",
            mod.uid,
            mod.folderName,
            meta?.displayName ?? "",
            meta?.description ?? "",
          ].some((val) => val.toLocaleLowerCase().includes(query));
          if (!matches) return false;
        }

        return true;
      })
      .slice()
      .sort((left, right) => {
        const metaLeft = vaultByUid.get(left.uid);
        const metaRight = vaultByUid.get(right.uid);

        switch (sort) {
          case "state":
            return (
              Number(right.enabled) - Number(left.enabled)
              || left.displayName.localeCompare(right.displayName)
            );
          case "name":
            return left.displayName.localeCompare(right.displayName);
          case "rating":
            return (metaRight?.ratingTenths ?? 0) - (metaLeft?.ratingTenths ?? 0);
          case "newest":
            return (Date.parse(metaRight?.createdAt ?? "") || 0) - (Date.parse(metaLeft?.createdAt ?? "") || 0);
          case "author":
            return (left.author ?? "").localeCompare(right.author ?? "");
        }
      });
  }, [
    installed, search, creator, preset, sort, modType, enabled, ranked,
    minimumRating, maximumRating, vaultByUid,
  ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageMods = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <>
      <SearchPanel
        className="installed-mod-search-panel"
        onSubmit={(event) => { event.preventDefault(); setPage(1); }}
        secondary={(
          <>
            {([
              ["all", t("mods.view.preset.all")],
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
                className={preset === key ? "active" : ""}
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
            <Button onClick={loadInstalled} disabled={installedStatus.type === "loading"}>
              <Icon name="refresh" size={15} /> {t("mods.installed.rescan")}
            </Button>
          </>
        )}
      >
        <SearchField label={t("mods.view.mod")} className="search-panel-field-grow">
          <input
            className="search-panel-control"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder={t("mods.installed.searchInstalledMods")}
          />
        </SearchField>
        <SearchField label={t("mods.view.creator")} className="search-panel-field-grow">
          <input
            className="search-panel-control"
            value={creator}
            onChange={(event) => {
              setCreator(event.target.value);
              setPage(1);
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
          onChange={(low, high) => {
            setMinimumRating(low);
            setMaximumRating(high);
            setPage(1);
          }}
        />
        <SearchField label={t("mods.view.type")} className="search-panel-field-compact">
          <select
            className="search-panel-control"
            value={modType}
            onChange={(event) => {
              setModType(event.target.value as ModTypeFilter);
              setPage(1);
            }}
          >
            <option value="all">{t("mods.installed.allTypes")}</option>
            <option value="ui">{t("mods.installed.uiMods")}</option>
            <option value="sim">{t("mods.installed.simMods")}</option>
          </select>
        </SearchField>
        <SearchField label="State" className="search-panel-field-compact">
          <select
            className="search-panel-control"
            value={enabled}
            onChange={(event) => {
              setEnabled(event.target.value as EnabledFilter);
              setPage(1);
            }}
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
            onChange={(event) => {
              setRanked(event.target.value as RankedFilter);
              setPage(1);
            }}
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

      {note && <p className="vault-note muted">{note}</p>}
      {installedStatus.type === "ready" && filtered.length === 0 ? (
        <EmptyState
          bordered
          icon={installed.length === 0 ? "mods" : "search"}
          title={t(installed.length === 0 ? "mods.installed.none" : "mods.installed.noMatch")}
          hint={t(installed.length === 0 ? "mods.installed.noneHint" : "mods.installed.noMatchHint")}
        />
      ) : filtered.length > 0 ? (
        <section className="installed-mod-library">
          <div className="vault-results-head">
            <span>{filtered.length} installed {filtered.length === 1 ? "mod" : "mods"}</span>
            <span>{installed.filter((mod) => mod.enabled).length} active</span>
          </div>
          <div className="installed-mod-grid">
            {pageMods.map((mod) => (
              <InstalledModCard
                key={mod.folderName}
                mod={mod}
                metadata={vaultByUid.get(mod.uid)}
                busy={busy}
                installing={installStatus.type === "installing" && installStatus.payload.uid === mod.uid}
                toggling={toggleStatus.type === "toggling" && toggleStatus.payload.uid === mod.uid}
                onToggle={() => toggleMod(mod.uid, !mod.enabled)}
                onUninstall={() => setPendingUninstall(mod)}
              />
            ))}
          </div>
          {totalPages > 1 && (
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={setPage}
            />
          )}
        </section>
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
