import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { RangeSlider } from "../../design-system/RangeSlider";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { focusListboxOption, nextListboxIndex } from "../../shared/listboxNavigation";
import { OFFICIAL_BASE_MAPS } from "../../shared/mapPresentation";
import { GameMapImage } from "./GameMapImage";
import { GenerateMapModal } from "../maps/GenerateMapModal";
import { HostModsColumn } from "./host/HostModsColumn";
import { FeaturedModIcon } from "./FeaturedModIcon";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n/catalog/en";

interface Props {
  onClose: () => void;
  initialTitle?: string;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** Map cells per kilometre, the engine's scale. */
const CELLS_PER_KM = 51.2;

const toKilometres = (cells: number) => Math.round(cells / CELLS_PER_KM);

/** Bounds for the map filter's sliders. 80 km is the largest map FA ships. */
const MAX_MAP_KM = 80;
const MAX_MAP_PLAYERS = 16;

type Range = { low: number | null; high: number | null };

const NO_RANGE: Range = { low: null, high: null };

const isBounded = (range: Range) => range.low !== null || range.high !== null;

/** A value passes when it is inside the range, or when it is simply unknown. */
function withinRange(value: number, range: Range): boolean {
  if (value <= 0) return true;
  if (range.low !== null && value < range.low) return false;
  return !(range.high !== null && value > range.high);
}

type HostMap = {
  displayName: string;
  folderName: string;
  maxPlayers: number;
  width: number;
  height: number;
  description?: string;
  version?: string;
  author?: string | null;
};

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

/** Show compact metadata for map rows. */
function formatMapMeta(map: { maxPlayers: number; width: number; height: number }): string {
  const parts: string[] = [];
  if (map.maxPlayers > 0) {
    parts.push(`${map.maxPlayers}p`);
  }
  if (map.width > 0 && map.height > 0) {
    parts.push(`${toKilometres(map.width)}×${toKilometres(map.height)}km`);
  }
  return parts.join(" · ");
}

/** Map dimensions in kilometres, which is the unit players actually use. */
function formatMapDimensions(width: number, height: number): string {
  if (width <= 0) return "";
  return `${toKilometres(width)} × ${toKilometres(height)} km`;
}

export function HostGameModal({ onClose, initialTitle }: Props) {
  const { t } = useTranslation();
  const player = useAppStore((state) => state.state.auth.player);
  const maps = useAppStore((state) => state.state.maps);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  const remembered = browsing.hostGame;

  /// `setBrowsing` replaces the whole preferences bag, so a writer must start
  /// from the newest copy rather than the one captured at render time. Saving a
  /// preset and closing the dialog in quick succession would otherwise write the
  /// preset straight back out again.
  const currentBrowsing = () => useAppStore.getState().state.settings.browsing;

  const [title, setTitle] = useState(
    initialTitle ??
      (remembered.title ||
        t("lobby.host.defaultTitle", { player: player?.name ?? t("lobby.matchmaker.player") })),
  );
  const [featuredMod, setFeaturedMod] = useState(remembered.featuredMod);
  const [visibility, setVisibility] = useState(remembered.visibility);
  const [passwordEnabled, setPasswordEnabled] = useState(remembered.passwordEnabled);
  const [password, setPassword] = useState(remembered.password);
  const [ratingEnabled, setRatingEnabled] = useState(remembered.enforceRatingRange);
  const [ratingMin, setRatingMin] = useState(remembered.ratingMin);
  const [ratingMax, setRatingMax] = useState(remembered.ratingMax);

  const [mapSearch, setMapSearch] = useState("");
  const [widthKm, setWidthKm] = useState<Range>(NO_RANGE);
  const [heightKm, setHeightKm] = useState<Range>(NO_RANGE);
  const [playerCount, setPlayerCount] = useState<Range>(NO_RANGE);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const mapListRef = useRef<HTMLDivElement>(null);
  const modListRef = useRef<HTMLDivElement>(null);
  const [selectedMap, setSelectedMap] = useState(remembered.map);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (!filtersOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (event.target instanceof Node && !filterRef.current?.contains(event.target)) {
        setFiltersOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFiltersOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [filtersOpen]);

  useEffect(() => {
    ipc.send({ kind: "Maps", command: { type: "loadInstalled" } });
    if (useAppStore.getState().state.maps.vaultStatus.type === "idle") {
      ipc.send({ kind: "Maps", command: { type: "loadVault" } });
    }
    ipc.send({ kind: "Mods", command: { type: "loadInstalled" } });
  }, []);

  const availableMaps = useMemo(() => {
    const search = mapSearch.trim().toLocaleLowerCase();
    const matches = (name: string) => !search || name.toLocaleLowerCase().includes(search);

    const mapByFolder = new Map<string, HostMap>();

    // 1. Official base-game maps
    const officialByFolder = new Map(
      OFFICIAL_BASE_MAPS.map((base) => [base.folderName.toLowerCase(), base]),
    );
    const officialByName = new Map(
      OFFICIAL_BASE_MAPS.map((base) => [base.displayName.toLowerCase(), base]),
    );

    for (const base of OFFICIAL_BASE_MAPS) {
      mapByFolder.set(base.folderName.toLowerCase(), {
        displayName: base.displayName,
        folderName: base.folderName,
        maxPlayers: base.maxPlayers,
        width: base.width,
        height: base.height,
        version: "1.0",
        description: "Official base game map.",
      });
    }

    // 2. Locally installed / vault maps
    const vaultByFolder = new Map(
      maps.vault.map((map) => [map.folderName.toLowerCase(), map]),
    );
    const vaultByName = new Map(
      maps.vault.map((map) => [map.displayName.toLowerCase(), map]),
    );

    for (const installed of maps.installed) {
      const key = installed.folderName.toLowerCase();
      const baseKey = key.replace(/\.v\d+$/i, "");
      const nameKey = installed.displayName.toLowerCase();

      const vaultMeta = vaultByFolder.get(key) ?? vaultByFolder.get(baseKey) ?? vaultByName.get(nameKey);
      const officialMeta = officialByFolder.get(key) ?? officialByFolder.get(baseKey) ?? officialByName.get(nameKey);
      const existing = mapByFolder.get(key) ?? mapByFolder.get(baseKey);

      const maxPlayers =
        (installed.maxPlayers && installed.maxPlayers > 0 ? installed.maxPlayers : 0) ||
        vaultMeta?.maxPlayers ||
        officialMeta?.maxPlayers ||
        existing?.maxPlayers ||
        0;

      const width =
        (installed.width && installed.width > 0 ? installed.width : 0) ||
        vaultMeta?.width ||
        officialMeta?.width ||
        existing?.width ||
        0;

      const height =
        (installed.height && installed.height > 0 ? installed.height : 0) ||
        vaultMeta?.height ||
        officialMeta?.height ||
        existing?.height ||
        0;

      const description =
        installed.description ||
        vaultMeta?.description ||
        existing?.description ||
        undefined;

      const version =
        installed.version ||
        vaultMeta?.version ||
        existing?.version;

      mapByFolder.set(key, {
        displayName: vaultMeta?.displayName ?? officialMeta?.displayName ?? installed.displayName,
        folderName: installed.folderName,
        maxPlayers,
        width,
        height,
        version: version ?? undefined,
        description,
        author: vaultMeta?.author,
      });
    }

    // 3. Ensure selectedMap is present (e.g. freshly generated Neroxis map)
    if (selectedMap && !mapByFolder.has(selectedMap.toLowerCase())) {
      mapByFolder.set(selectedMap.toLowerCase(), {
        displayName: selectedMap,
        folderName: selectedMap,
        maxPlayers: 16,
        width: 1024,
        height: 1024,
        version: "1.0",
        description: "Generated Neroxis map.",
      });
    }

    return Array.from(mapByFolder.values())
      .filter((map) => matches(map.displayName) || matches(map.folderName))
      .filter(
        (map) =>
          withinRange(map.maxPlayers, playerCount) &&
          withinRange(toKilometres(map.width), widthKm) &&
          withinRange(toKilometres(map.height), heightKm),
      )
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [
    heightKm,
    mapSearch,
    maps.installed,
    maps.vault,
    playerCount,
    selectedMap,
    widthKm,
  ]);

  const chosen = availableMaps.find((map) => map.folderName.toLowerCase() === selectedMap?.toLowerCase())
    ?? availableMaps.find((map) => map.folderName === selectedMap)
    ?? availableMaps[0];

  // Shown on the filter button so a narrowed list is never a mystery.
  const activeFilterCount = [widthKm, heightKm, playerCount].filter(isBounded).length;

  const titleError = !title.trim()
    ? t("lobby.host.error.title")
    : !PRINTABLE_ASCII.test(title.trim())
      ? t("lobby.host.error.titleAscii")
      : "";
  const passwordError = passwordEnabled && !PRINTABLE_ASCII.test(password)
    ? t("lobby.host.error.passwordAscii")
    : "";
  const ratingError = ratingEnabled && ratingMin > ratingMax
    ? t("lobby.host.error.ratingOrder")
    : "";
  const formError = titleError || passwordError || ratingError || (!chosen ? t("lobby.host.error.selectMap") : "");

  const chooseRandom = () => {
    if (availableMaps.length === 0) return;
    const index = Math.floor(Math.random() * availableMaps.length);
    setSelectedMap(availableMaps[index].folderName);
  };

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

  /// Walk the map list from the keyboard, selecting as it goes: the preview,
  /// the size and the player count all hang off the selection, so moving only
  /// focus - which is all the browser did - showed none of them.
  const onMapListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = availableMaps.findIndex((map) => map.folderName === chosen?.folderName);
    const next = nextListboxIndex(event.key, current, availableMaps.length);
    if (next === null) return;
    // Otherwise the arrow key also scrolls the column, away from the row it
    // just moved to.
    event.preventDefault();
    setSelectedMap(availableMaps[next].folderName);
    focusListboxOption(mapListRef.current, next);
  };

  const host = () => {
    if (formError || !chosen) return;
    ipc.send({
      kind: "Lobby",
      command: {
        type: "host",
        payload: {
          config: {
            title: title.trim(),
            modName: featuredMod,
            visibility,
            map: chosen.folderName,
            password: passwordEnabled && password ? password : null,
            enforceRatingRange: ratingEnabled,
            ratingMin: ratingEnabled ? ratingMin : null,
            ratingMax: ratingEnabled ? ratingMax : null,
          },
        },
      },
    });
    onClose();
  };

  const close = () => {
    ipc.send({
      kind: "Settings",
      command: {
        type: "setBrowsing",
        payload: {
          preferences: {
            ...currentBrowsing(),
            hostGame: {
              title,
              featuredMod,
              visibility,
              map: chosen?.folderName ?? selectedMap,
              passwordEnabled,
              password,
              enforceRatingRange: ratingEnabled,
              ratingMin,
              ratingMax,
            },
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
            <input
              className="number-input"
              type="number"
              disabled={!ratingEnabled}
              value={ratingMin}
              min={-9999}
              max={9999}
              aria-invalid={Boolean(ratingError)}
              onChange={(event) => setRatingMin(Number(event.target.value))}
              aria-label={t("lobby.host.minRating")}
            />
            <span className="muted">to</span>
            <input
              className="number-input"
              type="number"
              disabled={!ratingEnabled}
              value={ratingMax}
              min={-9999}
              max={9999}
              aria-invalid={Boolean(ratingError)}
              onChange={(event) => setRatingMax(Number(event.target.value))}
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
                      {mod.defaultMarker && <span className="host-badge-default">Default</span>}
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
        <section className="host-column host-column-maps surface-panel">
          <div className="host-column-header">
            <h3>{t("lobby.host.map")}</h3>
            <span className="host-count-badge">{availableMaps.length} maps</span>
          </div>

          <div className="host-map-search-row">
            <div className="search-field host-column-search host-map-search-field">
              <Icon name="search" size={13} />
              <input
                value={mapSearch}
                onChange={(event) => setMapSearch(event.target.value)}
                placeholder={t("lobby.host.searchMapsPlaceholder")}
                aria-label={t("lobby.host.searchMapsAria")}
              />
            </div>
            <div className="host-map-filter" ref={filterRef}>
              <button
                type="button"
                className={`host-map-filter-button${activeFilterCount > 0 ? " active" : ""}`}
                aria-expanded={filtersOpen}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                <Icon name="filter" size={13} />
                {t("lobby.host.filter")}
                {activeFilterCount > 0 && (
                  <span className="host-map-filter-count">{activeFilterCount}</span>
                )}
              </button>

              {/* A popover rather than a dialog: it filters the list behind it,
                  and that list has to stay visible while the sliders move. */}
              {filtersOpen && (
                <div className="host-map-filter-popover surface-panel" role="group">
                  <RangeSlider
                    label={t("lobby.host.filterWidth")}
                    min={0}
                    max={MAX_MAP_KM}
                    low={widthKm.low}
                    high={widthKm.high}
                    format={(value) => `${value} km`}
                    onChange={(low, high) => setWidthKm({ low, high })}
                  />
                  <RangeSlider
                    label={t("lobby.host.filterHeight")}
                    min={0}
                    max={MAX_MAP_KM}
                    low={heightKm.low}
                    high={heightKm.high}
                    format={(value) => `${value} km`}
                    onChange={(low, high) => setHeightKm({ low, high })}
                  />
                  <RangeSlider
                    label={t("lobby.host.filterPlayers")}
                    min={0}
                    max={MAX_MAP_PLAYERS}
                    low={playerCount.low}
                    high={playerCount.high}
                    onChange={(low, high) => setPlayerCount({ low, high })}
                  />
                  <button
                    type="button"
                    className="host-map-filter-reset"
                    disabled={activeFilterCount === 0}
                    onClick={() => {
                      setWidthKm(NO_RANGE);
                      setHeightKm(NO_RANGE);
                      setPlayerCount(NO_RANGE);
                    }}
                  >
                    {t("lobby.host.filterReset")}
                  </button>
                </div>
              )}
            </div>
          </div>

          <div
            ref={mapListRef}
            className="host-column-body host-map-list"
            role="listbox"
            aria-label={t("lobby.host.availableMaps")}
            onKeyDown={onMapListKeyDown}
          >
            {availableMaps.length === 0 ? (
              <p className="play-empty">{t("lobby.host.noMaps")}</p>
            ) : (
              availableMaps.map((map) => (
                <button
                  key={map.folderName}
                  type="button"
                  role="option"
                  aria-selected={chosen?.folderName === map.folderName}
                  className={`host-map-row${chosen?.folderName === map.folderName ? " active" : ""}`}
                  onClick={() => setSelectedMap(map.folderName)}
                >
                  <span className="host-map-name" title={map.displayName}>
                    {map.displayName}
                  </span>
                  <span className="host-map-meta">
                    {formatMapMeta(map) || t("lobby.host.playersUnstated")}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="host-column-footer host-map-actions">
            <Button className="host-col-action-btn" onClick={chooseRandom} title={t("lobby.host.randomTitle")}>
              <Icon name="refresh" size={14} />
              {t("lobby.host.randomMap")}
            </Button>
            <Button
              className="host-col-action-btn host-generate-btn"
              onClick={() => setGenerating(true)}
              title={t("lobby.host.generateTitle")}
            >
              <span className="host-generate-btn-label">
                <Icon name="plus" size={14} />
                <span>{t("lobby.host.generateMap")}</span>
              </span>
              <span className="host-badge-neroxis">Neroxis</span>
            </Button>
          </div>
        </section>

        {/* Column 4: Selected Map Details & Preview */}
        <section className="host-column host-column-preview surface-panel">
          <div className="host-column-header">
            <h3>{t("lobby.host.selectedMap")}</h3>
          </div>

          <div className="host-column-body host-preview-body">
            <div className="host-preview-thumb-wrap">
              {chosen ? (
                <GameMapImage
                  mapName={chosen.folderName}
                  vault={maps.vault}
                  className="host-preview-img"
                  placeholderClassName="host-preview-placeholder"
                  large
                />
              ) : (
                <div className="host-preview-placeholder">
                  <Icon name="maps" size={32} />
                </div>
              )}
              <div className="host-preview-overlay">
                <span className="host-preview-title" title={chosen?.displayName ?? t("lobby.host.selectMap")}>
                  {chosen?.displayName ?? t("lobby.host.selectMap")}
                </span>
              </div>
            </div>

            {chosen && (
              <div className="host-map-info-section">
                <div className="host-map-info-row">
                  <div className="host-map-info-item" title={t("lobby.host.mapPlayerCapacity")}>
                    <Icon name="users" size={13} />
                    <span>{chosen.maxPlayers > 0 ? `${chosen.maxPlayers} players` : "Players: N/A"}</span>
                  </div>
                  <div className="host-map-info-item" title={t("lobby.host.mapDimensions")}>
                    <Icon name="maps" size={13} />
                    <span>
                      {chosen.width > 0
                        ? formatMapDimensions(chosen.width, chosen.height)
                        : "Size: N/A"}
                    </span>
                  </div>
                </div>
                {(chosen.version || chosen.author) && (
                  <dl className="host-map-facts">
                    <dt>{t("lobby.host.mapAuthor")}</dt>
                    <dd>{chosen.author || t("lobby.host.mapAuthorUnknown")}</dd>
                    <dt>{t("lobby.host.mapVersion")}</dt>
                    <dd>{chosen.version || t("lobby.host.mapAuthorUnknown")}</dd>
                  </dl>
                )}
                {chosen.description && (
                  <p className="host-map-description">{chosen.description}</p>
                )}
              </div>
            )}
          </div>

        </section>
      </div>

      <div className="play-dialog-actions">
        {formError && <span className="host-form-global-error">{formError}</span>}
        <Button onClick={close}>{t("lobby.host.cancel")}</Button>
        <Button variant="primary" disabled={Boolean(formError)} onClick={host}>
          {t("lobby.host.submit")}
        </Button>
      </div>

      {generating && (
        <GenerateMapModal
          onClose={() => setGenerating(false)}
          onGenerated={(generated) => {
            const [first] = generated;
            if (first) {
              ipc.send({ kind: "Maps", command: { type: "loadInstalled" } });
              setSelectedMap(first);
              setMapSearch("");
            }
          }}
        />
      )}
    </Modal>
  );
}
