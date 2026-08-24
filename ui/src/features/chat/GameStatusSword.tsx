import type { GamePresenceStatus } from "./gameSummary";
import hostIcon from "./assets/status/host.png";
import lobbyIcon from "./assets/status/lobby.png";
import playingIcon from "./assets/status/playing.png";
import playing5Icon from "./assets/status/playing5.png";

interface Props {
  status: GamePresenceStatus;
  className?: string;
}

const STATUS_ICONS: Record<GamePresenceStatus, { src: string; alt: string }> = {
  hosting: { src: hostIcon, alt: "Host" },
  lobbying: { src: lobbyIcon, alt: "In lobby" },
  playing: { src: playingIcon, alt: "Playing" },
  playingDelayed: { src: playing5Icon, alt: "Playing (live replay delayed)" },
};

/**
 * Authentic FAF sword status indicator matching the reference Python client:
 * - `hosting`: Golden sword (host of an open lobby)
 * - `lobbying`: Single sword (participant in an open lobby)
 * - `playing`: Crossed swords (in a live game, watchable)
 * - `playingDelayed`: Red crossed swords (in a live game, safety delay active)
 */
export function GameStatusSword({ status, className = "" }: Props) {
  const icon = STATUS_ICONS[status];
  if (!icon) return null;

  return (
    <span
      className={`chat-game-sword is-${status} ${className}`.trim()}
      aria-hidden="true"
    >
      <img
        src={icon.src}
        alt={icon.alt}
        className="chat-game-sword-img"
        width={16}
        height={16}
        loading="eager"
        decoding="async"
        draggable={false}
      />
    </span>
  );
}
