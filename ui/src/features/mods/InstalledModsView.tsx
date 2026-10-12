import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { EmptyState } from "../../design-system/EmptyState";
import { FactsStrip } from "../../design-system/FactsStrip";
import { RangeSlider } from "../../design-system/RangeSlider";
import {
  SearchField,
  SearchPanel,
  SearchPanelToggle,
} from "../../design-system/SearchPanel";
import type { InstalledMod, VaultMod } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { includesNormalized, isWithinNumberRange } from "../../shared/filterRanges";
import { FailureNotice, LoadStatusNotice } from "../../shared/components/LoadNotices";
import { formatShortDate } from "../../shared/format/dates";
import { VaultDescription } from "../../shared/components/VaultDescription";
import { useAppStore } from "../../store/store";
import { Modal } from "../../design-system/Modal";
import { ModIcon, ModPreview, UninstallDialog, bestDescription, installNote, toggleNote } from "./ModVaultComponents";
import { favoriteModKeys, isFavoriteMod, toggleFavoriteMod } from "./favoriteMods";
import { modUpdateAvailable } from "./modVersions";
import { modCounterparts } from "./modIdentity";
import { useTranslation } from "../../i18n/useTranslation";
import { useRememberedFilters } from "../../shared/filterMemory";

type ModTypeFilter = "all" | "ui" | "sim";
type EnabledFilter = "all" | "enabled" | "disabled";
type RankedFilter = "all" | "ranked" | "unranked";
type InstalledModPreset = "all" | "favorites" | "enabled" | "disabled" | "ui" | "sim" | "updates";
type InstalledModSort = "state" | "name" | "rating" | "newest" | "author";

/** Where the library's filters are remembered (#447), and where they start. */
const INSTALLED_MOD_FILTERS = "mods.installed";
const NO_INSTALLED_MOD_FILTERS = {
  search: "",
  creator: "",
  preset: "all" as InstalledModPreset,
  modType: "all" as ModTypeFilter,
  enabled: "all" as EnabledFilter,
  ranked: "all" as RankedFilter,
  minimumRating: null as number | null,
  maximumRating: null as number | null,
};

const loadVault = () => ipc.send({ kind: "Mods", command: { type: "loadVault" } });
const loadInstalled = () => ipc.send({ kind: "Mods", command: { type: "loadInstalled" } });
const uninstallMod = (folderName: string, uid: string) =>
  ipc.send({
    kind: "Mods",
    command: { type: "uninstallMod", payload: { folderName, uid } },
  });
const updateMod = (uid: string, folderName: string, downloadUrl: string) =>
  ipc.send({
    kind: "Mods",
    command: { type: "updateMod", payload: { uid, folderName, downloadUrl } },
  });
const toggleMod = (uid: string, enabled: boolean) =>
  ipc.send({ kind: "Mods", command: { type: "toggleMod", payload: { uid, enabled } } });
/// One write and one rescan for a whole set, rather than one of each per mod:
/// every `toggleMod` rewrites `game.prefs` and walks the list through an
/// intermediate state on screen, which for a dozen favourites is a dozen
/// visible reorderings of the grid. The host dialog's mod column applies its
/// presets the same way.
const setActiveMods = (uids: string[]) =>
  ipc.send({ kind: "Mods", command: { type: "setActiveMods", payload: { uids } } });

interface InstalledModCardProps {
  mod: InstalledMod;
  metadata: VaultMod | undefined;
  busy: boolean;
  installing: boolean;
  toggling: boolean;
  favorite: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onToggleFavorite: () => void;
  /// Present only while the vault has a newer version than this folder.
  onUpdate?: () => void;
  onUninstall: () => void;
}

function InstalledModCard({
  mod,
  metadata,
  busy,
  installing,
  toggling,
  favorite,
  onOpen,
  onToggle,
  onToggleFavorite,
  onUpdate,
  onUninstall,
}: InstalledModCardProps) {
  const { t } = useTranslation();
  return (
    <article className={mod.enabled ? "installed-mod-card surface-panel is-enabled" : "installed-mod-card surface-panel is-disabled"}>
      {/* The description lives in the vault, and looking it up there was the
          only way to read it from this list. The card body is the link: the
          buttons stay outside it so enabling a mod is still one click. */}
      <button
        type="button"
        className="installed-mod-open"
        onClick={onOpen}
        title={t("mods.installed.openDetails")}
      >
        <ModIcon url={metadata?.thumbnailUrl} />
        <span className="installed-mod-copy">
          <span className="installed-mod-name" title={mod.uid}>
            <strong>{mod.displayName}</strong>
          </span>
          <small>
            {t(mod.modType === "ui" ? "mods.vault.uiMod" : "mods.vault.simMod")} · v{mod.version}
            {mod.author ? ` \u00b7 ${mod.author}` : ""}
          </small>
          {/* When the author last published it, from the vault's record of
              the mod. That says more about an installed mod than its uid,
              which stays on the name's tooltip; a mod the vault does not list
              has no date to give, so it keeps the uid line. */}
          {metadata ? (
            <small className="installed-mod-updated">
              {t("mods.vault.lastUpdated")} {formatShortDate(metadata.updatedAt || metadata.createdAt)}
            </small>
          ) : (
            <small title={mod.uid}>{mod.uid}</small>
          )}
        </span>
      </button>
      {/* Remove alone in the top right corner, away from the switches, so it
          is not what a quick click on enable lands on. The star, the update
          when there is one, and the switch together at the bottom right. All
          the same height; the state is the card's green edge and tint, and the
          switch says which way it goes. */}
      <div className="installed-mod-side">
        {/* An icon rather than the word, the way the Maps tab does it.
            "Uninstall" in red was the loudest thing on a row whose subject is
            the mod. */}
        <Button
          className="mod-vault-uninstall is-icon"
          disabled={busy}
          aria-label={t("mods.installed.uninstallNamed", { name: mod.displayName })}
          title={t(installing ? "mods.installed.working" : "mods.installed.uninstall")}
          onClick={onUninstall}
        >
          <Icon name="trash" size={14} />
        </Button>
        <div className="installed-mod-actions">
          {/* The same star as the vault's, on the screen where it pays: these
              are the mods the player already has, and the set they star is the
              one "Enable favourites" turns on before a game. */}
          <button
            type="button"
            className={favorite ? "mod-favorite-button active" : "mod-favorite-button"}
            aria-pressed={favorite}
            aria-label={t(favorite ? "mods.vault.removeFavoriteAria" : "mods.vault.addFavoriteAria", {
              name: mod.displayName,
            })}
            title={t(favorite ? "mods.vault.removeFavorite" : "mods.vault.addFavorite")}
            onClick={onToggleFavorite}
          >
            <Icon name="star" size={15} fill={favorite ? "currentColor" : "none"} />
          </button>
          {onUpdate && metadata && (
            <Button variant="primary" disabled={busy || !metadata.downloadUrl} onClick={onUpdate}>
              {t(installing ? "mods.installed.working" : "mods.vault.update")}
            </Button>
          )}
          <Button disabled={busy} onClick={onToggle}>
            {t(toggling ? "mods.installed.updating" : mod.enabled ? "mods.installed.disable" : "mods.installed.enable")}
          </Button>
        </div>
      </div>
    </article>
  );
}

/// What the vault detail panel shows, for a mod that is on disk.
///
/// Not the vault panel itself: that one is a column beside a result grid and
/// its actions are install/update, which is not what someone browsing their
/// own mods is doing. The content is the same, and the vault link is right
/// here for anything this cannot show (reviews, screenshots, history).
function InstalledModDetail({
  mod,
  metadata,
  busy,
  toggling,
  onClose,
  onToggle,
  onUpdate,
  onUninstall,
  onOpenInVault,
}: {
  mod: InstalledMod;
  metadata: VaultMod | undefined;
  busy: boolean;
  toggling: boolean;
  onClose: () => void;
  onToggle: () => void;
  /// Present only while the vault has a newer version than this folder.
  onUpdate?: () => void;
  onUninstall: () => void;
  onOpenInVault: () => void;
}) {
  const { t } = useTranslation();
  // The vault copy is the maintained one; `mod_info.lua` is what a mod that
  // was never published, or was taken down, still has.
  const description = bestDescription(metadata?.description, mod.description);
  const updateAvailable = Boolean(metadata && modUpdateAvailable(mod.version, metadata.version));
  return (
    <Modal className="installed-mod-modal" onClose={onClose} ariaLabel={mod.displayName}>
      <div className="installed-mod-detail">
        <div className="installed-mod-detail-preview">
          {metadata ? <ModPreview mod={metadata} large /> : <ModIcon large />}
        </div>
        <div className="installed-mod-detail-body">
          {/* The vault panel's reading order: the name, who made it, what
              kind of mod it is, then its facts on the tinted strip. */}
          <header className="mod-detail-head">
            <h2 className="mod-detail-name">{mod.displayName}</h2>
            <p className="mod-detail-byline">
              {mod.author ? t("mods.vault.authoredBy", { author: mod.author }) : t("mods.vault.unknownAuthor")}
            </p>
            <div className="mod-detail-tags">
              <span className={`mod-vault-type ${mod.modType}`}>
                {t(mod.modType === "ui" ? "mods.vault.uiMod" : "mods.vault.simMod")}
              </span>
              {mod.enabled && (
                <span className="mod-vault-type in-use" title={t("mods.vault.inUseHint")}>
                  {t("mods.vault.inUse")}
                </span>
              )}
              {updateAvailable && (
                <span className="mod-vault-type featured">{t("mods.view.updatesAvailable")}</span>
              )}
            </div>
          </header>

          <FactsStrip
            columns={2}
            groups={[{
              facts: [
                {
                  label: t("mods.vault.version"),
                  value: mod.version
                    ? `${t("common.version", { version: mod.version })}${updateAvailable && metadata ? ` → ${t("common.version", { version: metadata.version })}` : ""}`
                    : t("common.notAvailable"),
                  unknown: !mod.version,
                },
                {
                  label: t("mods.installed.stateLabel"),
                  value: t(mod.enabled ? "mods.installed.enabled" : "mods.installed.disabled"),
                },
                ...(metadata
                  ? [
                    {
                      label: t("mods.vault.reviews"),
                      value: metadata.reviews > 0
                        ? t("mods.vault.ratingSummary", { rating: (metadata.ratingTenths / 10).toFixed(1), reviews: metadata.reviews })
                        : t("mods.vault.notRated"),
                      unknown: metadata.reviews === 0,
                    },
                    { label: t("mods.vault.updated"), value: formatShortDate(metadata.updatedAt || metadata.createdAt) },
                  ]
                  : []),
              ],
            }]}
          />

          {/* Where it is on disk, for whoever has to find it there: long
              values, so a line each rather than a cell of the strip. */}
          <dl className="installed-mod-location">
            <div>
              <dt>{t("mods.installed.folder")}</dt>
              <dd>{mod.folderName}</dd>
            </div>
            <div>
              <dt>{t("mods.installed.uid")}</dt>
              <dd className="installed-mod-uid">{mod.uid}</dd>
            </div>
          </dl>

          <VaultDescription
            className="mod-vault-description"
            title={t("mods.vault.description")}
            description={description}
            empty={t("mods.vault.noDescription")}
          />

          {/* As in the vault panel: one action to a line, and the one the
              dialog is for last. */}
          <div className="mod-detail-actions">
            <div className="mod-detail-action-list">
              {metadata && (
                <Button variant="ghost" onClick={onOpenInVault}>
                  <Icon name="globe" size={15} />
                  {t("mods.installed.viewInVault")}
                </Button>
              )}
              {updateAvailable && onUpdate && (
                <Button variant="ghost" disabled={busy} onClick={onToggle}>
                  <Icon name={mod.enabled ? "close" : "check"} size={15} />
                  {t(toggling ? "mods.vault.toggling" : mod.enabled ? "mods.vault.disable" : "mods.vault.enable")}
                </Button>
              )}
              <Button variant="ghost" className="mod-detail-uninstall" disabled={busy} onClick={onUninstall}>
                <Icon name="trash" size={15} />
                {t("mods.vault.uninstall")}
              </Button>
            </div>
            {updateAvailable && onUpdate ? (
              <Button variant="primary" disabled={busy || !metadata?.downloadUrl} onClick={onUpdate}>
                <Icon name="download" size={15} />
                {t("mods.vault.installUpdate")}
              </Button>
            ) : (
              <Button variant={mod.enabled ? "ghost" : "primary"} disabled={busy} onClick={onToggle}>
                <Icon name={mod.enabled ? "close" : "check"} size={15} />
                {t(toggling ? "mods.vault.toggling" : mod.enabled ? "mods.vault.disable" : "mods.vault.enable")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function InstalledModsView({
  busy,
  onOpenInVault,
}: {
  busy: boolean;
  onOpenInVault: (modName: string) => void;
}) {
  const { t } = useTranslation();
  const installed = useAppStore((state) => state.state.mods.installed);
  const installedStatus = useAppStore((state) => state.state.mods.installedStatus);
  const vault = useAppStore((state) => state.state.mods.vault);
  const vaultStatus = useAppStore((state) => state.state.mods.vaultStatus);
  const installStatus = useAppStore((state) => state.state.mods.installStatus);
  const toggleStatus = useAppStore((state) => state.state.mods.toggleStatus);

  // The filters, remembered as the setting says (#447). The sort is not one.
  const { filters, setFilter } = useRememberedFilters(INSTALLED_MOD_FILTERS, NO_INSTALLED_MOD_FILTERS);
  const { search, creator, preset, modType, enabled, ranked, minimumRating, maximumRating } = filters;
  const setSearch = (value: string) => setFilter("search", value);
  const setCreator = (value: string) => setFilter("creator", value);
  const setPreset = (value: InstalledModPreset) => setFilter("preset", value);
  const setModType = (value: ModTypeFilter) => setFilter("modType", value);
  const setEnabled = (value: EnabledFilter) => setFilter("enabled", value);
  const setRanked = (value: RankedFilter) => setFilter("ranked", value);
  const setMinimumRating = (value: number | null) => setFilter("minimumRating", value);
  const setMaximumRating = (value: number | null) => setFilter("maximumRating", value);
  const [sort, setSort] = useState<InstalledModSort>("state");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [pendingUninstall, setPendingUninstall] = useState<InstalledMod | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  // The answer to "how do I know if a mod needs updating", which was the part
  // of the report nothing on this screen answered: the badges only appear once
  // the catalogue happens to have been reloaded, and nothing asks it to.
  const [checking, setChecking] = useState(false);
  /** Whether the reload a check asked for has been seen running yet. */
  const reloadSeen = useRef(false);
  /**
   * The catalogue on screen when the check was pressed. A reload that finished
   * always replaces it; one called off from the status bar leaves it, and has
   * found nothing to report.
   */
  const vaultAtCheck = useRef<VaultMod[] | null>(null);
  const [checkResult, setCheckResult] = useState("");
  const browsing = useAppStore((state) => state.state.settings.browsing);

  // An installed copy may be an older version than the one the vault lists,
  // and every version has its own uid: see `modIdentity`.
  const { vaultFor } = useMemo(() => modCounterparts(installed, vault), [installed, vault]);
  const favorites = useMemo(() => favoriteModKeys(browsing.favoriteMods), [browsing.favoriteMods]);
  // The starred mods that are installed and off. This is what the one-click
  // button acts on, and what its count says, so the two cannot disagree: a
  // starred mod that is already on is not work the button has to do, and a
  // star left over from an uninstalled mod is not a mod at all.
  const favoritesToEnable = useMemo(
    () => installed.filter((mod) => !mod.enabled && isFavoriteMod(favorites, mod.uid)),
    [favorites, installed],
  );
  const favoriteCount = useMemo(
    () => installed.filter((mod) => isFavoriteMod(favorites, mod.uid)).length,
    [favorites, installed],
  );

  /**
   * Turn on every starred mod, without turning anything else off.
   *
   * The ask was "enable all the mods you need in 1 click", which is what the
   * in-game mod manager's favourites do. Additive rather than a preset: the
   * host dialog already has presets, which are a complete wanted state and
   * switch off whatever they do not name, and quietly disabling a mod somebody
   * enabled a minute ago is not what a button called "Enable favourites" says
   * it does.
   */
  const enableFavorites = () => {
    const wanted = new Set(favoritesToEnable.map((mod) => mod.uid));
    setActiveMods(installed.filter((mod) => mod.enabled || wanted.has(mod.uid)).map((mod) => mod.uid));
  };

  // The installed list on every visit, because the folder changes under the
  // client; the vault once per session (the service refuses a repeat).
  useEffect(() => {
    loadInstalled();
    loadVault();
  }, []);

  // The catalogue reload finished: say what it found, and take the reader to
  // the mods it found it for. Silence would leave the button looking broken in
  // the common case, which is that everything is already current.
  useEffect(() => {
    if (!checking) return;
    // Only once the reload has started and then ended: the press lands while
    // the old catalogue still reads "ready", and judging that would report on
    // the very data the press was meant to replace.
    if (vaultStatus.type === "loading") {
      reloadSeen.current = true;
      return;
    }
    if (!reloadSeen.current) return;
    reloadSeen.current = false;
    setChecking(false);
    if (vaultStatus.type === "failed") {
      setCheckResult(t("mods.installed.checkFailed"));
      return;
    }
    // Called off: there is no new catalogue, and reporting on the old one
    // would answer a question the reader withdrew.
    if (vaultStatus.type === "cancelled" || vault === vaultAtCheck.current) return;
    const count = updatableFolders.size;
    setCheckResult(
      count > 0
        ? t("mods.installed.checkFound", { count })
        : t("mods.installed.checkNone"),
    );
    if (count > 0) choosePreset("updates");
    // `updatableFolders` is recomputed from the reloaded catalogue, and it is
    // the value this effect exists to read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checking, vaultStatus]);

  // The result is a note, not a state: it says what one press found and then
  // gets out of the way.
  useEffect(() => {
    if (!checkResult) return;
    const timer = window.setTimeout(() => setCheckResult(""), 6_000);
    return () => window.clearTimeout(timer);
  }, [checkResult]);

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
    } else if (next === "all" || next === "favorites") {
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
  };

  // One pass for both the count on the filter chip and the per-card question
  // of whether to offer the button, so the two can never disagree.
  const updatableFolders = useMemo(
    () => new Set(
      installed
        .filter((mod) => {
          const meta = vaultFor(mod);
          return meta && modUpdateAvailable(mod.version, meta.version);
        })
        .map((mod) => mod.folderName),
    ),
    [installed, vaultFor],
  );
  const updatesCount = updatableFolders.size;

  // What "More filters" holds that is not at its default. The type and the
  // state count only where they differ from what the chosen preset set them
  // to: the UI preset is a type filter already, and saying so twice would
  // send the reader looking for a filter they did not set.
  const presetType: ModTypeFilter = preset === "ui" || preset === "sim" ? preset : "all";
  const presetEnabled: EnabledFilter = preset === "enabled" || preset === "disabled" ? preset : "all";
  const hiddenFilterCount = Number(modType !== presetType)
    + Number(enabled !== presetEnabled)
    + Number(ranked !== "all")
    + Number(minimumRating !== null || maximumRating !== null);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const creatorQuery = creator.trim().toLocaleLowerCase();

    return installed
      .filter((mod) => {
        const meta = vaultFor(mod);
        const isRankedMod = meta?.ranked ?? false;
        const hasUpdate = meta && modUpdateAvailable(mod.version, meta.version);

        // The chip disappears with the last star, so the filter behind it has
        // to as well: otherwise un-starring everything leaves the list empty
        // with no visible filter to explain it.
        if (preset === "favorites" && favoriteCount > 0 && !isFavoriteMod(favorites, mod.uid)) {
          return false;
        }
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
        const metaLeft = vaultFor(left);
        const metaRight = vaultFor(right);

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
    minimumRating, maximumRating, vaultFor, favorites, favoriteCount,
  ]);

  // Looked up by folder rather than held as a copy: the list is replaced
  // wholesale after every toggle, and a copy would keep showing the old
  // enabled state behind the button that had just changed it.
  const opened = openFolder ? installed.find((mod) => mod.folderName === openFolder) : undefined;

  return (
    <>
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
          </>
        )}
        advanced={filtersOpen ? (
          <div className="search-panel-advanced">
            <div className="search-panel-advanced-grid mods-advanced-grid">
              <SearchField label={t("mods.view.type")}>
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
              <SearchField label={t("mods.installed.stateLabel")}>
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
              <SearchField label={t("mods.view.ranking")}>
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
            </div>
          </div>
        ) : undefined}
      >
        {/* The search row is the name and the creator; the list narrows as
            they are typed, so there is no button to press. */}
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
      </SearchPanel>

      <LoadStatusNotice
        status={installedStatus}
        failed={t("mods.installed.scanFailed")}
        onRetry={loadInstalled}
      />
      {/* Update, uninstall and enable/disable failures: the store had the
          reason, the screen only had a button that went back to normal. */}
      <FailureNotice status={installStatus} message={installNote(installStatus)} />
      <FailureNotice status={toggleStatus} message={toggleNote(toggleStatus)} />
      {/* What the filters left and how many of them the next game loads, then
          at the list's top right what is done to the library as a whole: look
          for updates, read the folder again, the order, and switching the
          starred mods on, last because it is the one that changes a game. */}
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
          onClick={() => {
            setCheckResult("");
            setChecking(true);
            vaultAtCheck.current = vault;
            // A real fetch: `loadVault` is refused once the catalogue is
            // loaded, which made this report on a stale one.
            ipc.send({ kind: "Mods", command: { type: "reloadVault" } });
          }}
        >
          <Icon name="download" size={15} />
          {t(checking ? "mods.installed.checking" : "mods.installed.checkUpdates")}
        </Button>
        <Button
          variant="ghost"
          className="mods-summary-tool"
          onClick={loadInstalled}
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
            onClick={enableFavorites}
          >
            <Icon name="star" size={15} fill="currentColor" />
            {t("mods.installed.enableFavorites")}
            {favoritesToEnable.length > 0 ? ` (${favoritesToEnable.length})` : ""}
          </Button>
        )}
      </div>
      {installedStatus.type === "ready" && filtered.length === 0 ? (
        <EmptyState
          bordered
          icon={installed.length === 0 ? "mods" : "search"}
          title={t(installed.length === 0 ? "mods.installed.none" : "mods.installed.noMatch")}
          hint={t(installed.length === 0 ? "mods.installed.noneHint" : "mods.installed.noMatchHint")}
        >
          {installed.length > 0 && <Button onClick={clearSearch}>{t("maps.view.clear")}</Button>}
        </EmptyState>
      ) : filtered.length > 0 ? (
        <section className="installed-mod-library">
          <div className="installed-mod-grid">
            {filtered.map((mod) => (
              <InstalledModCard
                key={mod.folderName}
                mod={mod}
                metadata={vaultFor(mod)}
                busy={busy}
                installing={installStatus.type === "installing" && installStatus.payload.uid === mod.uid}
                toggling={toggleStatus.type === "toggling" && toggleStatus.payload.uid === mod.uid}
                favorite={isFavoriteMod(favorites, mod.uid)}
                onOpen={() => setOpenFolder(mod.folderName)}
                onToggle={() => toggleMod(mod.uid, !mod.enabled)}
                onToggleFavorite={() => toggleFavoriteMod(browsing, mod.uid)}
                onUpdate={updatableFolders.has(mod.folderName)
                  ? () => {
                    const meta = vaultFor(mod);
                    if (meta) updateMod(meta.uid, mod.folderName, meta.downloadUrl);
                  }
                  : undefined}
                onUninstall={() => setPendingUninstall(mod)}
              />
            ))}
          </div>
        </section>
      ) : null}

      {opened && (
        <InstalledModDetail
          mod={opened}
          metadata={vaultFor(opened)}
          busy={busy}
          toggling={toggleStatus.type === "toggling" && toggleStatus.payload.uid === opened.uid}
          onClose={() => setOpenFolder(null)}
          onToggle={() => toggleMod(opened.uid, !opened.enabled)}
          onUpdate={() => {
            const meta = vaultFor(opened);
            if (meta) updateMod(meta.uid, opened.folderName, meta.downloadUrl);
          }}
          onUninstall={() => {
            setOpenFolder(null);
            setPendingUninstall(opened);
          }}
          onOpenInVault={() => {
            setOpenFolder(null);
            onOpenInVault(vaultFor(opened)?.displayName ?? opened.displayName);
          }}
        />
      )}

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
