import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { Modal } from "../../design-system/Modal";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { OFFICIAL_BASE_MAPS } from "../../shared/mapPresentation";
import { GameMapImage } from "./GameMapImage";
import { GenerateMapModal } from "../maps/GenerateMapModal";

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
};

/** Show only metadata we actually have for the map. */
function mapMeta(map: { maxPlayers: number; width: number; height: number }): string {
  const parts: string[] = [];
  if (map.maxPlayers > 0) parts.push(`${map.maxPlayers} players`);
  if (map.width > 0) parts.push(`${map.width}×${map.height}`);
  return parts.join(" · ");
}

export function HostGameModal({ onClose, forcedFeaturedMod, initialMap, initialTitle }: Props) {
  const player = useAppStore((state) => state.state.auth.player);
  const maps = useAppStore((state) => state.state.maps);
  const coopMissions = useAppStore((state) => state.state.coop.missions);
  const installedMods = useAppStore((state) => state.state.mods.installed);
  const browsing = useAppStore((state) => state.state.settings.browsing);
  const remembered = browsing.hostGame;
  const customGame = forcedFeaturedMod === undefined;
  const [title, setTitle] = useState(initialTitle ?? (remembered.title || `${player?.name ?? "Player"}'s game`));
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
  const [selectedMap, setSelectedMap] = useState(initialMap ?? remembered.map);
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
          });
        }
      }
    }

    return Array.from(mapByFolder.values())
      .filter((map) => matches(map.displayName))
      .filter((map) => map.maxPlayers === 0 || map.maxPlayers <= maxPlayers)
      .sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [coopMissions, mapSearch, maps.installed, maps.vault, maxPlayers]);

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
    ? "Enter a game title."
    : !PRINTABLE_ASCII.test(title.trim())
      ? "Game titles can only contain standard ASCII characters."
      : "";
  const passwordError = passwordEnabled && !PRINTABLE_ASCII.test(password)
    ? "Passwords can only contain standard ASCII characters."
    : "";
  const ratingError = ratingEnabled && ratingMin > ratingMax
    ? "Minimum rating cannot be greater than maximum rating."
    : "";
  const formError = titleError || passwordError || ratingError || (!chosen ? "Select a map." : "");

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
          <h2>{forcedFeaturedMod === "coop" ? "Host a co-op mission" : "Host a custom game"}</h2>
          <p>Choose the map, featured mod, access, and rating limits.</p>
        </div>
      </div>

      {/* Unified top game configuration card */}
      <section className="host-config-card surface-panel">
        <div className="host-config-primary-row">
          <label className="field host-field-title">
            <span>Game title</span>
            <input
              value={title}
              maxLength={128}
              aria-invalid={Boolean(titleError)}
              aria-describedby={titleError ? "host-title-error" : undefined}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Game title"
            />
            {titleError && <small id="host-title-error" className="host-field-error">{titleError}</small>}
          </label>

          <label className="field host-field-mod">
            <span>Featured mod</span>
            <select
              value={featuredMod}
              disabled={Boolean(forcedFeaturedMod)}
              onChange={(event) => setFeaturedMod(event.target.value)}
            >
              <option value="faf">Forged Alliance Forever</option>
              <option value="fafbeta">FAF Beta</option>
              <option value="nomads">Nomads</option>
              <option value="coop">Co-op</option>
            </select>
          </label>

          <label className="field host-field-visibility">
            <span>Visibility</span>
            <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
              <option value="public">Public</option>
              <option value="friends">Friends only</option>
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
              <span>Password protected</span>
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
                placeholder="Password"
                aria-label="Game password"
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
              <span>Enforce player rating</span>
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
                aria-label="Minimum rating"
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
                aria-label="Maximum rating"
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
                <span className="host-hero-eyebrow">Selected Map</span>
                <div className="host-hero-actions">
                  <Button onClick={chooseRandom} title="Choose a random map from the filtered list">
                    <Icon name="refresh" size={13} />
                    Random
                  </Button>
                  <Button onClick={() => setGenerating(true)} title="Generate a new Neroxis map">
                    <Icon name="plus" size={13} />
                    Generate
                  </Button>
                </div>
              </div>
              <h3 className="host-hero-title" title={chosen?.displayName ?? "Select a map"}>
                {chosen?.displayName ?? "Select a map"}
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
                placeholder="Search maps..."
                aria-label="Search maps"
              />
            </div>
            <select
              value={maxPlayers}
              onChange={(event) => setMaxPlayers(Number(event.target.value))}
              aria-label="Maximum map players"
            >
              <option value={2}>Up to 2 players</option>
              <option value={4}>Up to 4 players</option>
              <option value={8}>Up to 8 players</option>
              <option value={12}>Up to 12 players</option>
              <option value={16}>Up to 16 players</option>
            </select>
          </div>

          <div className="host-map-list" role="listbox" aria-label="Available maps">
            {availableMaps.length === 0 ? (
              <p className="play-empty">No matching maps found.</p>
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
                  <span className="host-map-meta">{mapMeta(map) || "Players unstated"}</span>
                </button>
              ))
            )}
          </div>
        </section>

        {/* Right Column: Active Mods Manager */}
        <section className="host-mods-column surface-panel">
          <header className="host-mods-header">
            <div>
              <h3>Active mods</h3>
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
              placeholder="Search mods..."
              aria-label="Search mods"
            />
          </div>

          <div className="host-mod-list">
            {filteredMods.length === 0 ? (
              <p className="play-empty">
                {installedMods.length === 0 ? "No installed mods." : "No mods match search."}
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
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" disabled={Boolean(formError)} onClick={host}>
          Host game
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
