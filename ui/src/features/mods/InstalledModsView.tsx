import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { EmptyState } from "../../design-system/EmptyState";
import { InstalledModSearchPanel } from "./InstalledModSearchPanel";
import { InstalledModSummary } from "./InstalledModSummary";
import type { InstalledMod } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { FailureNotice, LoadStatusNotice } from "../../shared/components/LoadNotices";
import { useAppStore } from "../../store/store";
import { InstalledModDetail } from "./InstalledModDetail";
import { InstalledModCard } from "./InstalledModCard";
import { UninstallDialog, installNote, toggleNote } from "./ModVaultComponents";
import { favoriteModKeys, isFavoriteMod, toggleFavoriteMod } from "./favoriteMods";
import { modUpdateAvailable } from "./modVersions";
import { modCounterparts } from "./modIdentity";
import { useTranslation } from "../../i18n/useTranslation";
import { useInstalledModFilters } from "./useInstalledModFilters";
import { useModUpdateCheck } from "./useModUpdateCheck";

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
  const [pendingUninstall, setPendingUninstall] = useState<InstalledMod | null>(null);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
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
  const filters = useInstalledModFilters({ installed, vaultFor, favorites, favoriteCount });
  const { choosePreset, clearSearch, filtered } = filters;

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

  const updateCheck = useModUpdateCheck({ vault, vaultStatus, updatableFolders, choosePreset });

  // Looked up by folder rather than held as a copy: the list is replaced
  // wholesale after every toggle, and a copy would keep showing the old
  // enabled state behind the button that had just changed it.
  const opened = openFolder ? installed.find((mod) => mod.folderName === openFolder) : undefined;

  return (
    <>
      <InstalledModSearchPanel
        filters={filters}
        favoriteCount={favoriteCount}
        updatesCount={updatesCount}
      />

      <LoadStatusNotice
        status={installedStatus}
        failed={t("mods.installed.scanFailed")}
        onRetry={loadInstalled}
      />
      {/* Update, uninstall and enable/disable failures: the store had the
          reason, the screen only had a button that went back to normal. */}
      <FailureNotice status={installStatus} message={installNote(installStatus)} />
      <FailureNotice status={toggleStatus} message={toggleNote(toggleStatus)} />
      <InstalledModSummary
        installed={installed}
        filters={filters}
        updateCheck={updateCheck}
        busy={busy}
        installedStatus={installedStatus}
        vaultStatus={vaultStatus}
        favoriteCount={favoriteCount}
        favoritesToEnable={favoritesToEnable}
        onEnableFavorites={enableFavorites}
        onRescan={loadInstalled}
      />
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
