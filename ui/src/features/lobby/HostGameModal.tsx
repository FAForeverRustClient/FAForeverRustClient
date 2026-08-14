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

interface Props {
  onClose: () => void;
  forcedFeaturedMod?: string;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

type HostMap = {
  displayName: string;
  folderName: string;
  maxPlayers: number;
  width: number;
  height: number;
};

/** Show only metadata we actually have for the map. */
function mapMeta(map: { maxPlayers: number; width: number; height: number }): string {
  const parts: string[] = [];
  if (map.maxPlayers > 0) parts.push(`${map.maxPlayers} players`);
  if (map.width > 0) parts.push(`${map.width}×${map.height}`);
  return parts.join(" · ");
}

export function HostGameModal({ onClose, forcedFeaturedMod }: Props) {
  const { t } = useTranslation();
  const player = useAppStore((state) => state.state.auth.player);
  const maps = useAppStore((state) => state.state.maps);
  const installedMods = useAppStore((state) => state.state.mods.installed);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  const remembered = browsing.hostGame;
  const customGame = forcedFeaturedMod === undefined;
  const [title, setTitle] = useState(remembered.title || t("lobby.host.defaultTitle", { player: player?.name ?? t("lobby.matchmaker.player") }));
  const [featuredMod, setFeaturedMod] = useState(forcedFeaturedMod ?? remembered.featuredMod);
  const [visibility, setVisibility] = useState(remembered.visibility);
  const [passwordEnabled, setPasswordEnabled] = useState(remembered.passwordEnabled);
  const [password, setPassword] = useState(remembered.password);
  const [ratingEnabled, setRatingEnabled] = useState(remembered.enforceRatingRange);
  const [ratingMin, setRatingMin] = useState(remembered.ratingMin);
  const [ratingMax, setRatingMax] = useState(remembered.ratingMax);
  const [mapSearch, setMapSearch] = useState("");
  const [modSearch, setModSearch] = useState("");
  const [maxPlayers, setMaxPlayers] = useState(16);
  const [selectedMap, setSelectedMap] = useState(remembered.map);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    ipc.send({ kind: "Maps", command: { type: "loadInstalled" } });
    ipc.send({ kind: "Mods", command: { type: "loadInstalled" } });
  }, []);

  const availableMaps = useMemo(() => {
    const search = mapSearch.trim().toLocaleLowerCase();
    const matches = (name: string) => !search || name.toLocaleLowerCase().includes(search);

    const mapByFolder = new Map<string, HostMap>();

    // 1. Official base-game maps (Seton's Clutch, Open Palms, Burial Mounds, etc.)
    for (const base of OFFICIAL_BASE_MAPS) {
      mapByFolder.set(base.folderName.toLocaleLowerCase(), {
        displayName: base.displayName,
        folderName: base.folderName,
        maxPlayers: base.maxPlayers,
        width: base.width,
        height: base.height,
      });
    }

    // 2. Locally installed / generated maps (Neroxis, local custom maps).
    // Vault metadata may enrich a local entry, but never makes an uninstalled
    // vault map hostable. This matches the Java client's installed-map list.
    const vaultByFolder = new Map(
      maps.vault.map((map) => [map.folderName.toLocaleLowerCase(), map]),
    );
    for (const installed of maps.installed) {
      const key = installed.folderName.toLocaleLowerCase();
      const metadata = vaultByFolder.get(key);
      mapByFolder.set(key, {
        displayName: metadata?.displayName ?? installed.displayName,
        folderName: installed.folderName,
        maxPlayers: metadata?.maxPlayers ?? 0,
        width: metadata?.width ?? 0,
        height: metadata?.height ?? 0,
      });
    }

    return Array.from(mapByFolder.values())
      .filter((map) => matches(map.displayName))
      .filter((map) => map.maxPlayers === 0 || map.maxPlayers <= maxPlayers)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [mapSearch, maps.installed, maps.vault, maxPlayers]);

  const chosen = availableMaps.find((map) => map.folderName === selectedMap) ?? availableMaps[0];

  const activeModsCount = useMemo(
    () => installedMods.filter((mod) => mod.enabled).length,
    [installedMods],
  );

  const filteredMods = useMemo(() => {
    const query = modSearch.trim().toLowerCase();
    if (!query) return installedMods;
    return installedMods.filter(
      (mod) =>
        mod.displayName.toLowerCase().includes(query) ||
        (mod.modType === "ui" && query === "ui") ||
        (mod.modType === "sim" && query === "sim"),
    );
  }, [installedMods, modSearch]);

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

      {/* Unified top game configuration card */}
      <section className="host-config-card surface-panel">
        <div className="host-config-primary-row">
          <label className="field host-field-title">
            <span>{t("lobby.host.gameTitle")}</span>
            <input
              value={title}
              maxLength={128}
              aria-invalid={Boolean(titleError)}
              aria-describedby={titleError ? "host-title-error" : undefined}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("lobby.host.gameTitle")}
            />
            {titleError && <small id="host-title-error" className="host-field-error">{titleError}</small>}
          </label>

          <label className="field host-field-mod">
            <span>{t("lobby.host.featuredMod")}</span>
            <select
              value={featuredMod}
              disabled={Boolean(forcedFeaturedMod)}
              onChange={(event) => setFeaturedMod(event.target.value)}
            >
              <option value="faf">{t("lobby.host.mod.faf")}</option>
              <option value="fafbeta">{t("lobby.host.mod.fafbeta")}</option>
              <option value="nomads">{t("lobby.host.mod.nomads")}</option>
              <option value="coop">{t("lobby.host.mod.coop")}</option>
            </select>
          </label>

          <label className="field host-field-visibility">
            <span>{t("lobby.host.visibility")}</span>
            <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
              <option value="public">{t("lobby.host.visibility.public")}</option>
              <option value="friends">{t("lobby.host.visibility.friends")}</option>
            </select>
          </label>
        </div>

        <div className="host-config-secondary-row">
          <div className="host-option-group">
            <label className="check-field">
              <input
                type="checkbox"
                checked={passwordEnabled}
                onChange={(event) => setPasswordEnabled(event.target.checked)}
              />
              <span>{t("lobby.host.passwordProtected")}</span>
            </label>
            <div className="host-inline-field">
              <input
                className="compact-input"
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
          </div>

          <div className="host-option-group">
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

      {/* 2-Column Master Layout */}
      <div className="host-2col-grid">
        {/* Left Column: Map Selection & Hero Preview */}
        <section className="host-map-column surface-panel">
          <div className="host-map-hero">
            <div className="host-hero-thumb">
              {chosen ? (
                <GameMapImage
                  mapName={chosen.folderName}
                  vault={maps.vault}
                  className="host-hero-image"
                  placeholderClassName="map-preview-placeholder"
                  large
                />
              ) : (
                <div className="map-preview-placeholder">
                  <Icon name="maps" size={28} />
                </div>
              )}
            </div>

            <div className="host-hero-details">
              <div className="host-hero-meta-top">
                <span className="host-hero-eyebrow">{t("lobby.host.selectedMap")}</span>
                <div className="host-hero-actions">
                  <Button onClick={chooseRandom} title={t("lobby.host.randomTitle")}>
                    <Icon name="refresh" size={13} />
                    {t("lobby.host.random")}
                  </Button>
                  <Button onClick={() => setGenerating(true)} title={t("lobby.host.generateTitle")}>
                    <Icon name="plus" size={13} />
                    {t("lobby.host.generate")}
                  </Button>
                </div>
              </div>
              <h3 className="host-hero-title" title={chosen?.displayName ?? t("lobby.host.selectMap")}>
                {chosen?.displayName ?? t("lobby.host.selectMap")}
              </h3>
              {chosen && mapMeta(chosen) && (
                <div className="host-hero-chips">
                  <span>{mapMeta(chosen)}</span>
                </div>
              )}
            </div>
          </div>

          <div className="host-map-filters">
            <div className="search-field host-map-search">
              <Icon name="search" size={14} />
              <input
                value={mapSearch}
                onChange={(event) => setMapSearch(event.target.value)}
                placeholder={t("lobby.host.searchMapsPlaceholder")}
                aria-label={t("lobby.host.searchMapsAria")}
              />
            </div>
            <select
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

          <div className="host-map-list" role="listbox" aria-label={t("lobby.host.availableMaps")}>
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
                  <span className="host-map-name">{map.displayName}</span>
                  <span className="host-map-meta">{mapMeta(map) || t("lobby.host.playersUnstated")}</span>
                </button>
              ))
            )}
          </div>
        </section>

        {/* Right Column: Active Mods Manager */}
        <section className="host-mods-column surface-panel">
          <header className="host-mods-header">
            <div>
              <h3>{t("lobby.host.activeMods")}</h3>
              <span className="host-count-badge">
                {activeModsCount} active · {installedMods.length} installed
              </span>
            </div>
          </header>

          <div className="search-field host-mod-search">
            <Icon name="search" size={14} />
            <input
              value={modSearch}
              onChange={(event) => setModSearch(event.target.value)}
              placeholder={t("lobby.host.searchModsPlaceholder")}
              aria-label={t("lobby.host.searchModsAria")}
            />
          </div>

          <div className="host-mod-list">
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
                  <span className="host-mod-name">{mod.displayName}</span>
                  <span className={`mod-badge mod-badge-${mod.modType}`}>
                    {mod.modType === "ui" ? "UI" : "SIM"}
                  </span>
                </label>
              ))
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
            // Select the new map straight away: generating from the host
            // dialog only ever means "host on this". `LoadInstalled` has
            // already been re-run by the generator service, so the folder is
            // in `maps.installed` by the time this fires.
            const [first] = generated;
            if (first) {
              setSelectedMap(first);
              // A generated name never matches a vault search term.
              setMapSearch("");
            }
          }}
        />
      )}
    </Modal>
  );
}
