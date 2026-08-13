// Custom Games subtab — the live open-games list. Auto-connects once on
// first view, then renders whatever the lobby slice holds; the list updates
// itself as the backend pushes GamesUpdated events. Adds tile/list views,
// client-side sort/filter, an avg-rating readout derived from the ratings
// cache, a collapsible detail panel, and the Host a Game dialog — all on top
// of the same connect/join plumbing the original flat list used.

import { useMemo, useState } from "react";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { Button } from "../../design-system/Button";
import { FriendsIcon, GameCard, LockIcon, mapArtStyle } from "../../design-system/Card";
import { Panel } from "../../design-system/Panel";
import { RangeSlider } from "../../design-system/RangeSlider";
import { HostGameDialog } from "./HostGameDialog";
import { mapLabel, useMapInfo } from "./mapInfo";
import type { Game, JoinState, LobbyStatus } from "../../ipc/bindings";

const STATUS_LABEL: Record<LobbyStatus, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Live",
};

const GAMEMODE_LABEL: Record<string, string> = {
  faf: "FAF",
  fafbeta: "FAF Beta Balance",
  fafdevelop: "FAF Develop",
  nomads: "Nomads",
};

const connect = () => ipc.dispatch({ kind: "Lobby", command: { type: "connect" } });
const disconnect = () => ipc.dispatch({ kind: "Lobby", command: { type: "disconnect" } });
const join = (id: number) =>
  ipc.dispatch({ kind: "Lobby", command: { type: "join", payload: { id } } });

type ViewMode = "tile" | "list";
type SortKey = "players" | "rating" | "title";

/** The join attempt's bearing on a specific game row. */
function rowJoin(joinState: JoinState, id: number): { label: string; busy: boolean; done: boolean } {
  const other = { label: "Join", busy: false, done: false };
  switch (joinState.type) {
    case "joining":
      return joinState.payload.id === id ? { label: "Joining…", busy: true, done: false } : other;
    case "launched":
      return joinState.payload.launch.uid === id
        ? { label: "Starting…", busy: true, done: false }
        : other;
    case "inGame":
      return { label: "In game", busy: true, done: true };
    case "failed":
      return joinState.payload.id === id ? { label: "Retry", busy: false, done: false } : other;
    case "launchFailed":
      return { label: "Join", busy: false, done: false };
    case "idle":
      return other;
  }
}

/** A human note about the current join attempt, shown in the header. */
function joinNote(joinState: JoinState): string | null {
  switch (joinState.type) {
    case "joining":
      return `Joining game ${joinState.payload.id}…`;
    case "launched":
      return `Launching “${joinState.payload.launch.name}” (${joinState.payload.launch.mapname})`;
    case "inGame":
      return "In game — adapter and game running";
    case "failed":
      return `Join failed: ${joinState.payload.reason}`;
    case "launchFailed":
      return `Launch failed: ${joinState.payload.reason}`;
    case "idle":
      return null;
  }
}

function gamemodeLabel(featuredMod: string): string {
  return GAMEMODE_LABEL[featuredMod] ?? featuredMod.toUpperCase();
}

/** Average rating across a game's rostered players, from the login→rating
 * cache. `null` if none of the roster's ratings have arrived yet. */
function avgRating(game: Game, ratings: Record<string, number>): number | null {
  const logins = Object.values(game.teams).flat();
  const known = logins.map((login) => ratings[login]).filter((r): r is number => r != null);
  if (known.length === 0) return null;
  return Math.round(known.reduce((a, b) => a + b, 0) / known.length);
}

export function CustomGamesView() {
  const lobby = useAppStore((s) => s.state.lobby);
  const mapInfo = useMapInfo();
  const [viewMode, setViewMode] = useState<ViewMode>("tile");
  const [sortKey, setSortKey] = useState<SortKey>("players");
  const [hidePrivate, setHidePrivate] = useState(false);
  const [hideModded, setHideModded] = useState(false);
  const [mapBlacklist, setMapBlacklist] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hostOpen, setHostOpen] = useState(false);

  const isLive = lobby.status === "connected" || lobby.status === "connecting";
  const note = joinNote(lobby.join);

  const blacklistTerms = useMemo(
    () =>
      mapBlacklist
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    [mapBlacklist],
  );

  const games = useMemo(() => {
    let list = lobby.games.filter((g) => {
      if (hidePrivate && g.passwordProtected) return false;
      if (hideModded && g.simMods.length > 0) return false;
      if (blacklistTerms.some((term) => g.map.toLowerCase().includes(term))) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
      switch (sortKey) {
        case "players":
          return b.players - a.players;
        case "title":
          return a.title.localeCompare(b.title);
        case "rating": {
          const ra = avgRating(a, lobby.ratings) ?? -1;
          const rb = avgRating(b, lobby.ratings) ?? -1;
          return rb - ra;
        }
      }
    });
    return list;
  }, [lobby.games, lobby.ratings, hidePrivate, hideModded, blacklistTerms, sortKey]);

  const selected = games.find((g) => g.id === selectedId) ?? null;

  // "Featured" pick — a simple activity proxy (fullest game), not a real
  // recommendation algorithm. Swap this out if/when personalized weighting
  // (rating fit, played maps, etc.) is worth building.
  const featured = useMemo(() => {
    const open = games.filter((g) => g.players < g.maxPlayers);
    if (open.length === 0) return null;
    return open.reduce((best, g) =>
      g.players / g.maxPlayers > best.players / best.maxPlayers ? g : best,
    );
  }, [games]);

  return (
    <div className="lobby">
      <div className="lobby-head">
        <h2>Custom Games</h2>
        <span className="muted">{STATUS_LABEL[lobby.status]}</span>
        {note && <span className="join-note muted">{note}</span>}
        <span className="spacer" />
        <Button onClick={() => setHostOpen(true)}>Host a Game</Button>
        <Button onClick={isLive ? disconnect : connect}>
          {isLive ? "Disconnect" : "Connect"}
        </Button>
      </div>

      <div className="lobby-head">
        <Button
          variant={viewMode === "tile" ? "primary" : "ghost"}
          onClick={() => setViewMode("tile")}
        >
          Tiles
        </Button>
        <Button
          variant={viewMode === "list" ? "primary" : "ghost"}
          onClick={() => setViewMode("list")}
        >
          List
        </Button>
        <select
          className="leaderboard-search"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as SortKey)}
        >
          <option value="players">Sort: Player count</option>
          <option value="rating">Sort: Avg rating</option>
          <option value="title">Sort: Title</option>
        </select>
        <label className="muted">
          <input type="checkbox" checked={hidePrivate} onChange={(e) => setHidePrivate(e.target.checked)} />{" "}
          Hide private
        </label>
        <label className="muted">
          <input type="checkbox" checked={hideModded} onChange={(e) => setHideModded(e.target.checked)} />{" "}
          Hide modded
        </label>
        <input
          className="leaderboard-search"
          placeholder="Map blacklist (comma-separated)"
          value={mapBlacklist}
          onChange={(e) => setMapBlacklist(e.target.value)}
        />
      </div>

      {viewMode === "tile" && featured && (
        <div className="hero-section">
          <div className="hero-eyebrow">Featured · Weighted pick for you</div>
          <button
            className="hero-tile"
            onClick={() => setSelectedId(featured.id)}
            onDoubleClick={() => join(featured.id)}
            style={mapArtStyle(featured.map, mapInfo.get(featured.map.toLowerCase())?.thumbnailUrl)}
          >
            <div className="hero-badge">{gamemodeLabel(featured.modName)}</div>
            <div className="hero-content">
              <span className="hero-pill">For you</span>
              <div className="hero-row">
                <div className="hero-titleblock">
                  <div className="hero-title">{featured.title}</div>
                  <div className="hero-meta">
                    {mapLabel(featured.map, mapInfo)} · {avgRating(featured, lobby.ratings) != null ? `~${avgRating(featured, lobby.ratings)} rating` : "unrated"}
                  </div>
                </div>
                <div className="hero-players-block">
                  <div className="hero-players">
                    {featured.players} / {featured.maxPlayers}
                  </div>
                  <div className="hero-hint">Double-click to join</div>
                </div>
              </div>
            </div>
          </button>
        </div>
      )}

      <div className="game-detail-layout">
        <div className="game-detail-main">
          {games.length === 0 ? (
            <p className="muted">No open games.</p>
          ) : viewMode === "tile" ? (
            <div className="game-tile-grid">
              {games.map((g) => (
                <GameCard
                  key={g.id}
                  title={g.title}
                  map={mapLabel(g.map, mapInfo)}
                  host={g.host}
                  players={g.players}
                  maxPlayers={g.maxPlayers}
                  gamemode={gamemodeLabel(g.modName)}
                  locked={g.passwordProtected}
                  friendsOnly={g.visibility === "friends"}
                  modCount={g.simMods.length}
                  avgRating={avgRating(g, lobby.ratings)}
                  thumbnailUrl={mapInfo.get(g.map.toLowerCase())?.thumbnailUrl}
                  selected={g.id === selectedId}
                  onClick={() => setSelectedId(g.id)}
                />
              ))}
            </div>
          ) : (
            <ul className="game-list">
              {games.map((g) => {
                const rj = rowJoin(lobby.join, g.id);
                return (
                  <li
                    key={g.id}
                    className={g.id === selectedId ? "game-row game-row-list game-tile-selected" : "game-row game-row-list"}
                    onClick={() => setSelectedId(g.id)}
                  >
                    <span className="game-title">
                      {g.visibility === "friends" && (
                        <span className="game-row-icon" title="Friends only">
                          <FriendsIcon />
                        </span>
                      )}
                      {g.passwordProtected && (
                        <span className="game-row-icon" title="Password protected">
                          <LockIcon />
                        </span>
                      )}
                      {g.title}
                    </span>
                    <span className="game-row-badge">{gamemodeLabel(g.modName)}</span>
                    <span className="game-map muted">{mapLabel(g.map, mapInfo)}</span>
                    <span className="game-host muted">host: {g.host}</span>
                    <span className="muted">{avgRating(g, lobby.ratings) ?? "—"}</span>
                    <span className="game-players">
                      {g.players}/{g.maxPlayers}
                    </span>
                    <Button
                      variant="primary"
                      disabled={rj.busy || rj.done || !isLive}
                      onClick={(e) => {
                        e.stopPropagation();
                        join(g.id);
                      }}
                    >
                      {rj.label}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <Panel open={selected != null} onClose={() => setSelectedId(null)}>
          {selected && (
            <>
              <div
                className="side-panel-hero"
                style={mapArtStyle(selected.map, mapInfo.get(selected.map.toLowerCase())?.thumbnailUrl)}
              >
                <div className="side-panel-hero-badge">{gamemodeLabel(selected.modName)}</div>
                {selected.passwordProtected && (
                  <div className="side-panel-hero-lock">
                    <LockIcon />
                  </div>
                )}
              </div>

              <div className="side-panel-body">
                <div className="side-panel-title">{selected.title}</div>
                <p className="side-panel-line">host: {selected.host}</p>
                <p className="side-panel-line">{mapLabel(selected.map, mapInfo)}</p>
                <p className="side-panel-line side-panel-line-strong">
                  {avgRating(selected, lobby.ratings) != null
                    ? `~${avgRating(selected, lobby.ratings)} avg rating`
                    : "unrated"}
                </p>

                <p className="side-panel-eyebrow">Rating range</p>
                <RangeSlider min={selected.ratingMin} max={selected.ratingMax} />
                {selected.enforceRatingRange && <p className="side-panel-line">Enforced</p>}

                <div className="side-panel-players-row">
                  <span className="side-panel-eyebrow">Players</span>
                  <span className="side-panel-players-count">
                    {selected.players} / {selected.maxPlayers}
                  </span>
                </div>

                <div className="side-panel-teams">
                  {Object.entries(selected.teams).map(([team, logins]) => (
                    <div key={team} className="side-panel-team">
                      <p className="side-panel-team-title">
                        {team === "-1" ? "No team" : `Team ${team}`}
                      </p>
                      {logins.map((login) => (
                        <div key={login} className="side-panel-player">
                          <span>{login}</span>
                          <span className="side-panel-player-rating">{lobby.ratings[login] ?? "—"}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>

                <div className="side-panel-divider" />

                <p className="side-panel-eyebrow">Mods · {selected.simMods.length}</p>
                {selected.simMods.length > 0 ? (
                  <div className="side-panel-mods">
                    {selected.simMods.map((m) => (
                      <span key={m} className="side-panel-mod-chip">
                        {m}
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="side-panel-line">No mods enabled</p>
                )}

                {(() => {
                  const rj = rowJoin(lobby.join, selected.id);
                  return (
                    <Button
                      variant="primary"
                      className="btn-block"
                      disabled={rj.busy || rj.done || !isLive}
                      onClick={() => join(selected.id)}
                    >
                      {rj.label}
                    </Button>
                  );
                })()}
                {selected.passwordProtected && (
                  <p className="side-panel-hint">Password required</p>
                )}
              </div>
            </>
          )}
        </Panel>
      </div>

      {hostOpen && <HostGameDialog onClose={() => setHostOpen(false)} />}
    </div>
  );
}
