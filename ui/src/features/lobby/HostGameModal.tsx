import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { OFFICIAL_BASE_MAPS } from "../../shared/mapPresentation";
import { GameMapImage } from "./GameMapImage";
import { GenerateMapModal } from "../maps/GenerateMapModal";
import { useTranslation } from "../../i18n/useTranslation";
import type { MessageKey } from "../../i18n/catalog/en";

interface Props {
  onClose: () => void;
  forcedFeaturedMod?: string;
  initialMap?: string;
  initialTitle?: string;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

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

type ModTab = "all" | "sim" | "ui";

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
    const kmW = (map.width / 51.2).toFixed(0);
    const kmH = (map.height / 51.2).toFixed(0);
    parts.push(`${kmW}×${kmH}km`);
  }
  return parts.join(" · ");
}

/** Show detailed dimensions for preview panel. */
function formatMapDimensions(width: number, height: number): string {
  if (width <= 0) return "";
  const kmW = (width / 51.2).toFixed(0);
  const kmH = (height / 51.2).toFixed(0);
  return `${kmW} × ${kmH} km (${width}×${height})`;
}

export function HostGameModal({ onClose, forcedFeaturedMod, initialMap, initialTitle }: Props) {
  const { t } = useTranslation();
  const player = useAppStore((state) => state.state.auth.player);
  const maps = useAppStore((state) => state.state.maps);
  const coopMissions = useAppStore((state) => state.state.coop.missions);
  const installedMods = useAppStore((state) => state.state.mods.installed);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  const remembered = browsing.hostGame;
  const customGame = forcedFeaturedMod === undefined;

  const [title, setTitle] = useState(
    initialTitle ??
      (remembered.title ||
        t("lobby.host.defaultTitle", { player: player?.name ?? t("lobby.matchmaker.player") })),
  );
  const [featuredMod, setFeaturedMod] = useState(forcedFeaturedMod ?? remembered.featuredMod);
  const [visibility, setVisibility] = useState(remembered.visibility);
  const [passwordEnabled, setPasswordEnabled] = useState(remembered.passwordEnabled);
  const [password, setPassword] = useState(remembered.password);
  const [ratingEnabled, setRatingEnabled] = useState(remembered.enforceRatingRange);
  const [ratingMin, setRatingMin] = useState(remembered.ratingMin);
  const [ratingMax, setRatingMax] = useState(remembered.ratingMax);

  const [modTab, setModTab] = useState<ModTab>("all");
  const [modSearch, setModSearch] = useState("");
  const [mapSearch, setMapSearch] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(16);
  const [selectedMap, setSelectedMap] = useState(initialMap ?? remembered.map);
  const [generating, setGenerating] = useState(false);

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

    // 3. Co-op campaign missions
    for (const mission of coopMissions) {
      if (mission.mapFolderName) {
        const key = mission.mapFolderName.toLocaleLowerCase();
        if (!mapByFolder.has(key)) {
          mapByFolder.set(key, {
            displayName: mission.name,
            folderName: mission.mapFolderName,
            maxPlayers: 4,
            width: 0,
            height: 0,
            description: mission.description,
          });
        }
      }
    }

    // 4. Ensure selectedMap is present (e.g. freshly generated Neroxis map)
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
      .filter((map) => map.maxPlayers === 0 || map.maxPlayers <= maxPlayers)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [coopMissions, mapSearch, maps.installed, maps.vault, maxPlayers, selectedMap]);

  const chosen = availableMaps.find((map) => map.folderName.toLowerCase() === selectedMap?.toLowerCase())
    ?? availableMaps.find((map) => map.folderName === selectedMap)
    ?? availableMaps[0];

  const displayedFeaturedMods: FeaturedModOption[] = useMemo(() => {
    if (forcedFeaturedMod && !FEATURED_MODS.some((m) => m.id === forcedFeaturedMod)) {
      return [
        ...FEATURED_MODS,
        {
          id: forcedFeaturedMod,
          nameKey: forcedFeaturedMod === "coop" ? "lobby.host.mod.coop" : "lobby.host.mod.faf",
          descKey: forcedFeaturedMod === "coop" ? "lobby.host.mod.coopDesc" : "lobby.host.mod.fafDesc",
        },
      ];
    }
    return FEATURED_MODS;
  }, [forcedFeaturedMod]);

  const activeModsCount = useMemo(
    () => installedMods.filter((mod) => mod.enabled).length,
    [installedMods],
  );

  const simModsCount = useMemo(
    () => installedMods.filter((mod) => mod.modType === "sim").length,
    [installedMods],
  );

  const uiModsCount = useMemo(
    () => installedMods.filter((mod) => mod.modType === "ui").length,
    [installedMods],
  );

  const filteredMods = useMemo(() => {
    const query = modSearch.trim().toLowerCase();
    return installedMods
      .filter((mod) => {
        if (modTab === "sim" && mod.modType !== "sim") return false;
        if (modTab === "ui" && mod.modType !== "ui") return false;
        if (!query) return true;
        return (
          mod.displayName.toLowerCase().includes(query) ||
          (mod.modType === "ui" && query === "ui") ||
          (mod.modType === "sim" && query === "sim")
        );
      })
      .sort(
        (a, b) =>
          Number(b.enabled) - Number(a.enabled) ||
          a.displayName.localeCompare(b.displayName),
      );
  }, [installedMods, modSearch, modTab]);

  const deselectAllMods = () => {
    for (const mod of installedMods) {
      if (mod.enabled) {
        ipc.send({
          kind: "Mods",
          command: {
            type: "toggleMod",
            payload: { uid: mod.uid, enabled: false },
          },
        });
      }
    }
  };

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
    if (customGame) {
      ipc.send({
        kind: "Settings",
        command: {
          type: "setBrowsing",
          payload: {
            preferences: {
              ...browsing,
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
    }
    onClose();
  };

  return (
    <Modal className="host-game-modal" onClose={close}>
      <div className="play-dialog-head">
        <div>
          <h2>{t(forcedFeaturedMod === "coop" ? "lobby.host.titleCoop" : "lobby.host.titleCustom")}</h2>
          <p>{t("lobby.host.subtitle")}</p>
        </div>
      </div>

      {/* Top Header Row: Title, Password, Friends Only, Rating Limits */}
      <section className="host-top-config surface-panel">
        <div className="host-top-title-wrap">
          <input
            className="host-title-input"
            value={title}
            maxLength={128}
            aria-invalid={Boolean(titleError)}
            aria-describedby={titleError ? "host-title-error" : undefined}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("lobby.host.gameTitle")}
          />
          {titleError && <small id="host-title-error" className="host-field-error">{titleError}</small>}
        </div>

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
      </section>

      {/* 4-Column Layout (Parity with Java Client) */}
      <div className="host-game-grid">
        {/* Column 1: Game Type (Featured Mods) */}
        <section className="host-column host-column-gametype surface-panel">
          <div className="host-column-header">
            <h3>{t("lobby.host.gameType")}</h3>
          </div>
          <div className="host-column-body host-gametype-list" role="listbox">
            {displayedFeaturedMods.map((mod) => {
              const active = featuredMod === mod.id;
              const disabled = Boolean(forcedFeaturedMod) && forcedFeaturedMod !== mod.id;
              return (
                <button
                  key={mod.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={disabled}
                  className={`host-gametype-row${active ? " active" : ""}`}
                  onClick={() => setFeaturedMod(mod.id)}
                >
                  <div className="host-gametype-title-row">
                    <span className="host-gametype-name">{t(mod.nameKey)}</span>
                    {mod.defaultMarker && <span className="host-badge-default">Default</span>}
                  </div>
                  <span className="host-gametype-desc">{t(mod.descKey)}</span>
                </button>
              );
            })}
          </div>
        </section>

        {/* Column 2: Mods (Sim & UI Mods Manager) */}
        <section className="host-column host-column-mods surface-panel">
          <div className="host-column-header">
            <h3>{t("lobby.host.mods")}</h3>
            <span className="host-count-badge">
              {activeModsCount} active · {installedMods.length} installed
            </span>
          </div>

          <div className="host-mod-tabs">
            <button
              type="button"
              className={`host-mod-tab${modTab === "all" ? " active" : ""}`}
              onClick={() => setModTab("all")}
            >
              {t("lobby.host.allMods")} ({installedMods.length})
            </button>
            <button
              type="button"
              className={`host-mod-tab${modTab === "sim" ? " active" : ""}`}
              onClick={() => setModTab("sim")}
            >
              {t("lobby.host.simMods")} ({simModsCount})
            </button>
            <button
              type="button"
              className={`host-mod-tab${modTab === "ui" ? " active" : ""}`}
              onClick={() => setModTab("ui")}
            >
              {t("lobby.host.uiMods")} ({uiModsCount})
            </button>
          </div>

          <div className="search-field host-column-search">
            <Icon name="search" size={13} />
            <input
              value={modSearch}
              onChange={(event) => setModSearch(event.target.value)}
              placeholder={t("lobby.host.searchModsPlaceholder")}
              aria-label={t("lobby.host.searchModsAria")}
            />
          </div>

          <div className="host-column-body host-mod-list">
            {filteredMods.length === 0 ? (
              <p className="play-empty">
                {t(installedMods.length === 0 ? "lobby.host.noInstalledMods" : "lobby.host.noModsMatch")}
              </p>
            ) : (
              filteredMods.map((mod) => (
                <label key={mod.uid} className={`host-mod-row${mod.enabled ? " is-active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={mod.enabled}
                    onChange={(event) =>
                      ipc.send({
                        kind: "Mods",
                        command: {
                          type: "toggleMod",
                          payload: { uid: mod.uid, enabled: event.target.checked },
                        },
                      })
                    }
                  />
                  <span className="host-mod-name" title={mod.displayName}>
                    {mod.displayName}
                  </span>
                  <span className={`mod-badge mod-badge-${mod.modType}`}>
                    {mod.modType === "ui" ? "UI" : "SIM"}
                  </span>
                </label>
              ))
            )}
          </div>

          <div className="host-column-footer">
            <Button
              className="host-col-action-btn"
              disabled={activeModsCount === 0}
              onClick={deselectAllMods}
            >
              {t("lobby.host.deselectAll")}
            </Button>
          </div>
        </section>

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
            <select
              className="host-players-select"
              value={maxPlayers}
              onChange={(event) => setMaxPlayers(Number(event.target.value))}
              aria-label={t("lobby.host.maxPlayersAria")}
            >
              <option value={2}>{t("lobby.host.upTo", { count: 2 })}</option>
              <option value={4}>{t("lobby.host.upTo", { count: 4 })}</option>
              <option value={8}>{t("lobby.host.upTo", { count: 8 })}</option>
              <option value={12}>{t("lobby.host.upTo", { count: 12 })}</option>
              <option value={16}>{t("lobby.host.upTo", { count: 16 })}</option>
            </select>
          </div>

          <div className="host-column-body host-map-list" role="listbox" aria-label={t("lobby.host.availableMaps")}>
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

          <div className="host-column-footer">
            <Button className="host-col-action-btn" onClick={chooseRandom} title={t("lobby.host.randomTitle")}>
              <Icon name="refresh" size={14} />
              {t("lobby.host.randomMap")}
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
                  <div className="host-map-info-footer">
                    {chosen.version && <span className="host-map-version-badge">v{chosen.version}</span>}
                    {chosen.author && <span className="host-map-author-label">by {chosen.author}</span>}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="host-column-footer">
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
