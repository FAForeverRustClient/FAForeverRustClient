// GameCard primitive: a custom-games tile. Structure and values matched
// directly against the forgeDark reference mockup's extracted source (a
// 140px full-bleed tile: map-art background, a mod badge top-left,
// lock/mod-count badges top-right, a 2-line clamped title, host/meta text
// bottom-left, player count + a thin capacity bar bottom-right: the whole
// tile inverts to a cream fill on hover). The lobby protocol itself has no
// map thumbnail, but the map vault does (`VaultMap.thumbnailUrl`): callers
// resolve `thumbnailUrl` by matching the game's map id against the vault
// (see `shared/mapPresentation.ts`) and pass it in; falls back to a
// deterministic gradient hashed from the map name for maps not in the vault
// (unranked/custom maps) or before the vault has loaded.

import type { CSSProperties } from "react";

interface GameCardProps {
  title: string;
  map: string;
  host: string;
  players: number;
  maxPlayers: number;
  gamemode: string;
  locked: boolean;
  friendsOnly?: boolean;
  modCount?: number;
  avgRating?: number | null;
  thumbnailUrl?: string;
  selected?: boolean;
  onClick?: () => void;
}

/** The art layer's inline style: a real map thumbnail (with a dark scrim for
 * text legibility) if we have one, otherwise the hashed-gradient fallback.
 * Shared by the tile, hero banner, and detail panel so they stay consistent. */
export function mapArtStyle(map: string, thumbnailUrl?: string): CSSProperties {
  const hue = hashHue(map);
  const gradient = `radial-gradient(120% 140% at 15% 0%, hsl(${hue} 60% 38%) 0%, transparent 55%), radial-gradient(90% 120% at 90% 100%, hsl(${(hue + 40) % 360} 45% 22%) 0%, transparent 60%)`;
  if (thumbnailUrl) {
    return {
      backgroundImage: `linear-gradient(180deg, rgba(8,8,10,0.15), rgba(8,8,10,0.55)), url("${thumbnailUrl}")`,
      backgroundSize: "cover",
      backgroundPosition: "center",
    };
  }
  return { background: gradient };
}

/** A stable hue (0-359) derived from a string, so the same map always gets the
 * same placeholder color. */
export function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function LockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="4" y="11" width="16" height="10" rx="1.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

export function FriendsIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" aria-hidden="true">
      <circle cx="5.5" cy="6" r="2" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="10.8" cy="6" r="2" stroke="currentColor" strokeWidth="1.2" />
      <path d="M1.8 13c.4-2.1 1.9-3.4 3.7-3.4s3.3 1.3 3.7 3.4M8.4 9.8c1.6.1 2.9 1.4 3.3 3.2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function GameCard({
  title,
  map,
  host,
  players,
  maxPlayers,
  gamemode,
  locked,
  friendsOnly,
  modCount,
  avgRating,
  thumbnailUrl,
  selected,
  onClick,
}: GameCardProps) {
  const fillPct = maxPlayers > 0 ? Math.round((players / maxPlayers) * 100) : 0;
  return (
    <button
      className={selected ? "game-tile game-tile-selected" : "game-tile"}
      onClick={onClick}
    >
      <div className="game-tile-art" style={mapArtStyle(map, thumbnailUrl)} />
      <div className="game-tile-badge">{gamemode}</div>
      <div className="game-tile-icons">
        {friendsOnly && (
          <span className="game-tile-icon" aria-label="Friends only" title="Friends only">
            <FriendsIcon />
          </span>
        )}
        {locked && (
          <span className="game-tile-icon" aria-label="Password protected" title="Password protected">
            <LockIcon />
          </span>
        )}
        {!!modCount && <span className="game-tile-mods">Mods {modCount}</span>}
      </div>

      <div className="game-tile-content">
        <div className="game-tile-title">{title}</div>
        <div className="game-tile-footer">
          <div className="game-tile-meta">
            <span className="game-tile-host">host: {host}</span>
            <span className="game-tile-map">
              {map}
              {avgRating != null && ` · ~${avgRating}`}
            </span>
          </div>
          <div className="game-tile-capacity">
            <span className="game-tile-players">
              {players}/{maxPlayers}
            </span>
            <div className="game-tile-bar">
              <div className="game-tile-bar-track" />
              <div className="game-tile-bar-fill" style={{ width: `${fillPct}%` }} />
            </div>
          </div>
        </div>
      </div>
    </button>
  );
}
