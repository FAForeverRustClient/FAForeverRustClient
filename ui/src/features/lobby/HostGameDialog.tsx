// Host a Game dialog — collects a HostGameRequest and dispatches Lobby.Host.
// Map/mod pickers reuse the Maps/Mods vault state and loadVault() commands
// already wired up for the Maps/Mods tabs (see MapsView.tsx/ModsView.tsx) —
// no new backend calls needed for browsing. Mod presets are a first-pass
// localStorage-only feature (no backend slice yet; revisit if the user wants
// presets synced/shared later).

import { useEffect, useMemo, useState } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { Button } from "../../design-system/Button";
import { Modal } from "../../design-system/Modal";
import { RangeSlider } from "../../design-system/RangeSlider";
import type { GameVisibility, VaultMod } from "../../ipc/bindings";

const GAMEMODES: { value: string; label: string }[] = [
  { value: "faf", label: "FAF" },
  { value: "fafbeta", label: "FAF Beta Balance" },
  { value: "fafdevelop", label: "FAF Develop" },
  { value: "nomads", label: "Nomads" },
];

// Public generator page — a real in-app integration needs its own research
// pass (bundled CLI vs. web API); this is a stub link-out, not the real thing.
const MAP_GENERATOR_URL = "https://generator.faforever.com/";

const PRESETS_KEY = "forge.hostModPresets";

function loadPresets(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(PRESETS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function savePresets(presets: Record<string, string[]>) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets));
}

/** Strip a trailing version suffix (`.v0001`) from a map folder name to get
 * the scenario id the `game_host`/`game_info` protocol uses as `mapname`. */
function toMapname(folderName: string): string {
  return folderName.replace(/\.v\d+$/i, "");
}

interface HostGameDialogProps {
  onClose: () => void;
}

export function HostGameDialog({ onClose }: HostGameDialogProps) {
  const maps = useAppStore((s) => s.state.maps);
  const mods = useAppStore((s) => s.state.mods);
  const host = useAppStore((s) => s.state.lobby.host);

  const [title, setTitle] = useState("");
  const [mapSearch, setMapSearch] = useState("");
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [gamemode, setGamemode] = useState("faf");
  const [friendsOnly, setFriendsOnly] = useState(false);
  const [password, setPassword] = useState("");
  const [ratingMin, setRatingMin] = useState<number | null>(null);
  const [ratingMax, setRatingMax] = useState<number | null>(null);
  const [enforceRating, setEnforceRating] = useState(false);
  const [selectedModUids, setSelectedModUids] = useState<Set<string>>(new Set());
  const [presets, setPresets] = useState(loadPresets);
  const [presetChoice, setPresetChoice] = useState("");

  useEffect(() => {
    if (maps.vaultStatus.type === "idle") {
      ipc.dispatch({ kind: "Maps", command: { type: "loadVault" } });
    }
    if (mods.vaultStatus.type === "idle") {
      ipc.dispatch({ kind: "Mods", command: { type: "loadVault" } });
    }
  }, []);

  // Close the dialog once hosting succeeds.
  useEffect(() => {
    if (host.type === "hosted") onClose();
  }, [host]);

  const filteredMaps = useMemo(() => {
    const term = mapSearch.trim().toLowerCase();
    if (!term) return maps.vault;
    return maps.vault.filter((m) => m.displayName.toLowerCase().includes(term));
  }, [maps.vault, mapSearch]);

  const uiMods = mods.vault.filter((m) => m.modType === "ui");
  const simMods = mods.vault.filter((m) => m.modType === "sim");

  const toggleMod = (uid: string) => {
    setSelectedModUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const applyPreset = (name: string) => {
    setPresetChoice(name);
    const uids = presets[name];
    if (uids) setSelectedModUids(new Set(uids));
  };

  const saveAsPreset = () => {
    const name = window.prompt("Preset name?");
    if (!name) return;
    const next = { ...presets, [name]: Array.from(selectedModUids) };
    setPresets(next);
    savePresets(next);
    setPresetChoice(name);
  };

  const canSubmit = title.trim().length > 0 && selectedFolder != null && host.type !== "hosting";

  const submit = () => {
    if (!canSubmit || selectedFolder == null) return;
    const visibility: GameVisibility = friendsOnly ? "friends" : "public";
    ipc.dispatch({
      kind: "Lobby",
      command: {
        type: "host",
        payload: {
          req: {
            title: title.trim(),
            mapname: toMapname(selectedFolder),
            featuredMod: gamemode,
            password: password.trim().length > 0 ? password.trim() : null,
            visibility,
            ratingMin,
            ratingMax,
            enforceRatingRange: enforceRating,
            simMods: Array.from(selectedModUids),
          },
        },
      },
    });
  };

  return (
    <Modal onClose={onClose}>
      <h2>Host a Game</h2>

      <div className="host-field">
        <label>Lobby title</label>
        <input
          className="leaderboard-search"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. 1k+ Free-for-all"
        />
      </div>

      <div className="host-field">
        <label>Gamemode</label>
        <select
          className="leaderboard-search"
          value={gamemode}
          onChange={(e) => setGamemode(e.target.value)}
        >
          {GAMEMODES.map((g) => (
            <option key={g.value} value={g.value}>
              {g.label}
            </option>
          ))}
        </select>
      </div>

      <div className="host-field">
        <label>Map</label>
        <input
          className="leaderboard-search"
          value={mapSearch}
          onChange={(e) => setMapSearch(e.target.value)}
          placeholder="Search maps…"
        />
        <div className="host-map-list">
          {filteredMaps.map((m) => (
            <button
              key={m.folderName}
              className={m.folderName === selectedFolder ? "tab tab-active" : "tab"}
              onClick={() => setSelectedFolder(m.folderName)}
            >
              {m.displayName}
            </button>
          ))}
        </div>
        <a href={MAP_GENERATOR_URL} target="_blank" rel="noreferrer" className="btn-ghost host-generate-link">
          Generate a map…
        </a>
      </div>

      <div className="host-field">
        <label>
          <input type="checkbox" checked={friendsOnly} onChange={(e) => setFriendsOnly(e.target.checked)} />{" "}
          Friends only
        </label>
      </div>

      <div className="host-field">
        <label>Password (optional)</label>
        <input
          className="leaderboard-search"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <div className="host-field">
        <label>
          <input
            type="checkbox"
            checked={enforceRating}
            onChange={(e) => setEnforceRating(e.target.checked)}
          />{" "}
          Enforce desired rating
        </label>
        <RangeSlider
          min={ratingMin}
          max={ratingMax}
          onChange={(lo, hi) => {
            setRatingMin(lo);
            setRatingMax(hi);
          }}
        />
      </div>

      <div className="host-field">
        <label>Mod preset</label>
        <select
          className="leaderboard-search"
          value={presetChoice}
          onChange={(e) => applyPreset(e.target.value)}
        >
          <option value="">— none —</option>
          {Object.keys(presets).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <Button onClick={saveAsPreset}>Save current mods as preset</Button>
      </div>

      <div className="host-field host-mods-columns">
        <div>
          <p className="side-panel-team-title">UI mods</p>
          {uiMods.map((m: VaultMod) => (
            <label key={m.uid} className="host-mod-row">
              <input
                type="checkbox"
                checked={selectedModUids.has(m.uid)}
                onChange={() => toggleMod(m.uid)}
              />
              {m.displayName}
            </label>
          ))}
        </div>
        <div>
          <p className="side-panel-team-title">SIM mods</p>
          {simMods.map((m: VaultMod) => (
            <label key={m.uid} className="host-mod-row">
              <input
                type="checkbox"
                checked={selectedModUids.has(m.uid)}
                onChange={() => toggleMod(m.uid)}
              />
              {m.displayName}
            </label>
          ))}
        </div>
      </div>

      {host.type === "failed" && <p className="error">{host.payload.reason}</p>}

      <Button variant="primary" className="btn-block" disabled={!canSubmit} onClick={submit}>
        {host.type === "hosting" ? "Hosting…" : "Host"}
      </Button>
    </Modal>
  );
}
