import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../design-system/Button";
import { Modal } from "../../../design-system/Modal";
import { ipc } from "../../../ipc/client";
import { useAppStore } from "../../../store/store";
import { focusListboxOption, nextListboxIndex } from "../../../shared/listboxNavigation";
import { GameMapImage } from "../GameMapImage";
import { MapPreviewDialog } from "../../../shared/components/MapPreviewZoom";
import { isOfficialMap } from "../../../shared/mapPresentation";
import { MapUninstallDialog } from "../../maps/MapVaultComponents";
import { GenerateMapModal } from "../../maps/GenerateMapModal";
import { HostModsColumn } from "./HostModsColumn";
import { useHostLobbySettings } from "./hostLobbySettings";
import {
  buildHostCatalogue,
  buildVaultIndex,
  formatMapMeta,
  withUncataloguedMaps,
  type HostMap,
} from "./hostMapCatalogue";
import { useHostMapPicker } from "./useHostMapPicker";
import { HostMapListColumn } from "./HostMapListColumn";
import { HostMapDetailsColumn } from "./HostMapDetailsColumn";
import { FeaturedModIcon } from "../../../shared/components/FeaturedModIcon";
import { useTranslation } from "../../../i18n/useTranslation";
import type { MessageKey } from "../../../i18n/catalog/en";
import { OptionalNumberInput } from "../../../design-system/NumberInput";
// The map column's two tabs borrow the shared tab strip. Imported here rather
// than relied on: this dialog is reachable from screens that never load it.
import "../../../design-system/section-tabs.css";

interface Props {
  onClose: () => void;
  initialTitle?: string;
}

interface FeaturedModOption {
  id: string;
  nameKey: MessageKey;
  descKey: MessageKey;
  defaultMarker?: boolean;
}

const FEATURED_MODS: FeaturedModOption[] = [
  { id: "faf", nameKey: "lobby.host.mod.faf", descKey: "lobby.host.mod.fafDesc", defaultMarker: true },
  { id: "fafbeta", nameKey: "lobby.host.mod.fafbeta", descKey: "lobby.host.mod.fafbetaDesc" },
  { id: "fafdevelop", nameKey: "lobby.host.mod.fafdevelop", descKey: "lobby.host.mod.fafdevelopDesc" },
  { id: "nomads", nameKey: "lobby.host.mod.nomads", descKey: "lobby.host.mod.nomadsDesc" },
];

/**
 * Memoised, and its props are kept stable by the view that opens it.
 *
 * This dialog is a child of the Play tab, which re-renders whenever the lobby
 * sends a game list -- continuously, on a busy server. Nothing in here reads
 * the game list, but React re-renders a child whose parent re-rendered, and
 * this child is the largest tree in the client: measured at 3 752 DOM nodes
 * with 448 maps installed, and 92 ms per re-render in a development build.
 * A handful of lobby updates a second is then most of a core, spent rebuilding
 * a dialog whose contents did not change, which is the "CPU climbs while the
 * host window is open" report.
 *
 * The dialog still updates when its own data does: it subscribes to the store
 * itself, and those subscriptions are unaffected by `memo`.
 */
export const HostGameModal = memo(function HostGameModal({ onClose, initialTitle }: Props) {
  const { t } = useTranslation();
  // The fields this dialog reads, each its own subscription. The whole maps
  // slice redrew it for every install, preview and pool answer the Maps tab
  // asks for, and the whole browsing slice for every list column resized.
  const vault = useAppStore((state) => state.state.maps.vault);
  const installed = useAppStore((state) => state.state.maps.installed);
  const favoriteMaps = useAppStore((state) => state.state.settings.browsing.favoriteMaps);
  const remembered = useAppStore((state) => state.state.settings.browsing.hostGame);
  // The window's own form history over the title field, which is not something
  // this client stores; see `GeneralPreferences::remember_typed_entries`.
  const rememberTypedEntries = useAppStore((state) => state.state.settings.general.rememberTypedEntries);

  // Title, who may join, and the rating window: the same fields and rules as
  // the co-op dialog, so they come from the same hook rather than a second
  // copy of each `useState` and each validation message.
  const settings = useHostLobbySettings(initialTitle, "hostGame");
  const {
    title, setTitle, visibility, setVisibility, passwordEnabled, setPasswordEnabled,
    password, setPassword, ratingEnabled, setRatingEnabled, ratingMin, setRatingMin,
    ratingMax, setRatingMax, titleError, passwordError, ratingError,
  } = settings;
  // What is hosted, on top of the admission fields.
  const [featuredMod, setFeaturedMod] = useState(remembered.featuredMod);
  const [selectedMap, setSelectedMap] = useState(remembered.map);

  // The map catalogue, in three memos rather than one.
  //
  // This used to be a single `useMemo` keyed on everything, including the
  // search text and the selected map. So typing one character into the map
  // filter, or clicking one row in the list, rebuilt two lookup indexes over
  // the *entire map vault* -- which the maps service calls "the most expensive
  // thing this client does" to crawl, and which is tens of thousands of
  // entries -- then re-merged every installed map against them, then sorted
  // the result, and then re-rendered every row. That is four string
  // allocations per vault entry per keystroke, and it is why the host dialog
  // in particular made the CPU climb.
  //
  // Split by what each step actually depends on: the vault index changes when
  // the vault loads, the merge when the installed maps change, and only the
  // filtering and sorting follow the search box (in `useHostMapPicker`).
  const vaultIndex = useMemo(() => buildVaultIndex(vault), [vault]);

  const catalogue = useMemo(
    () => buildHostCatalogue(installed, vaultIndex, t("lobby.host.mapOfficialDescription")),
    [installed, vaultIndex, t],
  );

  // A map generated a moment ago is not in the installed list yet, and has to
  // be selectable anyway. One appended entry rather than a reason to rebuild
  // the merge above every time the selection moves.
  const catalogueMaps = useMemo(
    () => withUncataloguedMaps(
      catalogue,
      selectedMap,
      favoriteMaps,
      t("lobby.host.mapGeneratedDescription"),
    ),
    [favoriteMaps, catalogue, selectedMap, t],
  );

  // Filters, favourites, keyboard selection and the enlarged preview. Called
  // here, ahead of the loads below, so its effects keep their original order.
  const mapPicker = useHostMapPicker({
    catalogueMaps,
    favoriteMaps,
    selectedMap,
    setSelectedMap,
  });
  const { chosen, filter, previewOpen, setPreviewOpen } = mapPicker;

  const [pendingUninstall, setPendingUninstall] = useState<HostMap | null>(null);
  const [generating, setGenerating] = useState(false);
  // Stable, so the memoised map columns are not redrawn by the form fields.
  const openGenerator = useCallback(() => setGenerating(true), []);
  const enlargePreview = useCallback(() => setPreviewOpen(true), [setPreviewOpen]);
  const modListRef = useRef<HTMLDivElement>(null);

  // The vault is loaded once per session and the service ignores a repeat;
  // the installed lists are rescanned on every open.
  useEffect(() => {
    ipc.send({ kind: "Maps", command: { type: "loadInstalled" } });
    ipc.send({ kind: "Maps", command: { type: "loadVault" } });
    ipc.send({ kind: "Mods", command: { type: "loadInstalled" } });
  }, []);

  // Only a map that is really on disk, and never one the game ships: a base
  // map cannot be deleted and a vault entry that is not installed has nothing
  // here to delete.
  const canUninstallChosen = Boolean(
    chosen
    && !isOfficialMap(chosen.folderName)
    && installed.some((map) => map.folderName === chosen.folderName),
  );

  const formError = titleError || passwordError || ratingError || (!chosen ? t("lobby.host.error.selectMap") : "");

  /// The same for the game-type column beside it. A column that ignores the
  /// arrow keys next to one that answers them reads as broken.
  const onModListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = FEATURED_MODS.findIndex((mod) => mod.id === featuredMod);
    const next = nextListboxIndex(event.key, current, FEATURED_MODS.length);
    if (next === null) return;
    event.preventDefault();
    setFeaturedMod(FEATURED_MODS[next].id);
    focusListboxOption(modListRef.current, next);
  };

  const host = () => {
    if (formError || !chosen) return;
    ipc.send({
      kind: "Lobby",
      command: {
        type: "host",
        payload: {
          // The rating range is only sent when enforced (see `hostConfig`).
          // An advisory range the server does not act on is the badge that
          // started this: it looked like a rule.
          config: { ...settings.hostConfig(), modName: featuredMod, map: chosen.folderName },
        },
      },
    });
    onClose();
  };

  const close = () => {
    ipc.send({
      kind: "Settings",
      command: {
        type: "patchBrowsing",
        payload: {
          patch: {
            hostGame: settings.remembered(featuredMod, chosen?.folderName ?? selectedMap),
          },
        },
      },
    });
    onClose();
  };

  return (
    <Modal className="host-game-modal" onClose={close}>
      <div className="play-dialog-head">
        <div>
          <h2>{t("lobby.host.titleCustom")}</h2>
          <p>{t("lobby.host.subtitle")}</p>
        </div>
      </div>

      {/* Top Header Row: Title, Password, Friends Only, Rating Limits */}
      <section className="host-top-config surface-panel">
        <div className="host-top-title-wrap">
          <label className="host-top-label" htmlFor="host-lobby-name">
            {t("lobby.host.gameTitle")}
          </label>
          <input
            id="host-lobby-name"
            className="host-title-input"
            name="faf-game-title"
            autoComplete={rememberTypedEntries ? "on" : "off"}
            value={title}
            maxLength={128}
            aria-invalid={Boolean(titleError)}
            aria-describedby={titleError ? "host-title-error" : undefined}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("lobby.host.gameTitle")}
          />
          {titleError && <small id="host-title-error" className="host-field-error host-title-error">{titleError}</small>}
        </div>

        <div className="host-top-options-row">
        {/* Password */}
        <div className="host-option-item">
          <label className="check-field">
            <input
              type="checkbox"
              checked={passwordEnabled}
              onChange={(event) => setPasswordEnabled(event.target.checked)}
            />
            <span>{t("lobby.host.passwordProtected")}</span>
          </label>
          <input
            className="compact-input host-password-input"
            type="password"
            disabled={!passwordEnabled}
            value={password}
            maxLength={25}
            aria-invalid={Boolean(passwordError)}
            aria-describedby={passwordError ? "host-password-error" : undefined}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t("lobby.host.password")}
            aria-label={t("lobby.host.passwordAria")}
          />
          {passwordError && <small id="host-password-error" className="host-field-error">{passwordError}</small>}
        </div>

        {/* Friends only */}
        <div className="host-option-item">
          <label className="check-field">
            <input
              type="checkbox"
              checked={visibility === "friends"}
              onChange={(event) => setVisibility(event.target.checked ? "friends" : "public")}
            />
            <span>{t("lobby.host.onlyFriends")}</span>
          </label>
        </div>

        {/* Rating boundaries */}
        <div className="host-option-item host-rating-option">
          <label className="check-field">
            <input
              type="checkbox"
              checked={ratingEnabled}
              onChange={(event) => setRatingEnabled(event.target.checked)}
            />
            <span>{t("lobby.host.enforceRating")}</span>
          </label>
          <div className="host-rating-inputs">
            {/* Never disabled. A range that cannot be typed until a checkbox
                is found is a range nobody sets, and the numbers are useful on
                their own: unenforced they are the sign on the door, enforced
                they are the door. */}
            <OptionalNumberInput
              className="number-input"
              placeholder={t("common.any")}
              value={ratingMin}
              min={-9999}
              max={9999}
              aria-invalid={Boolean(ratingError)}
              onChange={setRatingMin}
              aria-label={t("lobby.host.minRating")}
            />
            <span className="muted">{t("lobby.host.ratingTo")}</span>
            <OptionalNumberInput
              className="number-input"
              placeholder={t("common.any")}
              value={ratingMax}
              min={-9999}
              max={9999}
              aria-invalid={Boolean(ratingError)}
              onChange={setRatingMax}
              aria-label={t("lobby.host.maxRating")}
            />
          </div>
          {ratingError && <small className="host-field-error host-rating-error">{ratingError}</small>}
        </div>
        </div>
      </section>

      {/* 4-Column Layout (Parity with Java Client) */}
      <div className="host-game-grid">
        {/* Column 1: Game Type (Featured Mods) */}
        <section className="host-column host-column-gametype surface-panel">
          <div className="host-column-header">
            <h3>{t("lobby.host.gameType")}</h3>
          </div>
          <div
            ref={modListRef}
            className="host-column-body host-gametype-list"
            role="listbox"
            aria-label={t("lobby.host.gameType")}
            onKeyDown={onModListKeyDown}
          >
            {FEATURED_MODS.map((mod) => {
              const active = featuredMod === mod.id;
              return (
                <button
                  key={mod.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`host-gametype-row${active ? " active" : ""}`}
                  onClick={() => setFeaturedMod(mod.id)}
                >
                  <FeaturedModIcon modId={mod.id} className="host-gametype-icon" />
                  <div className="host-gametype-info">
                    <div className="host-gametype-title-row">
                      <span className="host-gametype-name">{t(mod.nameKey)}</span>
                      {mod.defaultMarker && <span className="host-badge-default">{t("lobby.host.defaultBadge")}</span>}
                    </div>
                    <span className="host-gametype-desc">{t(mod.descKey)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Column 2: Mods */}
        <HostModsColumn />

        {/* Column 3: Map List */}
        <HostMapListColumn picker={mapPicker} onGenerate={openGenerator} />

        {/* Column 4: Selected Map Details & Preview */}
        <HostMapDetailsColumn
          chosen={chosen}
          vault={vault}
          canUninstall={canUninstallChosen}
          onEnlarge={enlargePreview}
          onUninstall={setPendingUninstall}
        />
      </div>

      <div className="play-dialog-actions">
        {formError && <span className="host-form-global-error">{formError}</span>}
        <Button onClick={close}>{t("lobby.host.cancel")}</Button>
        <Button variant="primary" disabled={Boolean(formError)} onClick={host}>
          {t("lobby.host.submit")}
        </Button>
      </div>

      {pendingUninstall && (
        <MapUninstallDialog
          mapName={pendingUninstall.displayName}
          onCancel={() => setPendingUninstall(null)}
          onConfirm={() => {
            ipc.send({
              kind: "Maps",
              command: {
                type: "uninstallMap",
                payload: { folderName: pendingUninstall.folderName },
              },
            });
            setPendingUninstall(null);
          }}
        />
      )}

      {generating && (
        <GenerateMapModal
          onClose={() => setGenerating(false)}
          onGenerated={(generated) => {
            const [first] = generated;
            if (first) {
              ipc.send({ kind: "Maps", command: { type: "loadInstalled" } });
              setSelectedMap(first);
              filter({ mapSearch: "" });
            }
          }}
        />
      )}

      {/* The enlarged map, with the Maps tab's zoom. `GameMapImage` rather than
          the vault's own art, because a map picked here can be one the
          generator just made, which the vault has never heard of. */}
      {previewOpen && chosen && (
        <MapPreviewDialog
          map={{ folderName: chosen.folderName, displayName: chosen.displayName }}
          onClose={() => setPreviewOpen(false)}
          meta={formatMapMeta(chosen) || t("lobby.host.playersUnstated")}
        >
          <GameMapImage
            mapName={chosen.folderName}
            vault={vault}
            className="host-preview-zoom-img"
            placeholderClassName="host-preview-placeholder"
            large
          />
        </MapPreviewDialog>
      )}
    </Modal>
  );
});
