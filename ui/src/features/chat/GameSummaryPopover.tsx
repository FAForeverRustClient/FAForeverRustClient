import { useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SocialState, VaultMap } from "../../ipc/bindings";
import { MapThumbnail } from "../../shared/MapThumbnail";
import { flagSrc } from "../../shared/countryFlags";
import { mapPresentation } from "../../shared/mapPresentation";
import { gameTeamSummaries, type GamePresence } from "./gameSummary";
import type { MessageKey } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";

const STATUS_LABEL = {
  hosting: "chat.presence.hosting",
  lobbying: "chat.presence.lobbying",
  playing: "chat.presence.playing",
} as const satisfies Record<GamePresence["status"], MessageKey>;

interface Props {
  presence: GamePresence;
  social: SocialState;
  vault: VaultMap[];
}

export function GameSummaryPopover({ presence, social, vault }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 8, right: 8 });
  const anchor = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  const presentation = mapPresentation(vault, presence.game.map);

  const updatePosition = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      top: Math.max(8, Math.min(rect.top, window.innerHeight - 280)),
      right: Math.max(8, window.innerWidth - rect.left + 8),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  // Team/profile joins are only needed for the one card currently visible;
  // closed badges stay cheap even in a several-hundred-user channel.
  const teams = open ? gameTeamSummaries(presence.game, social) : [];
  const { t } = useTranslation();
  const status = t(STATUS_LABEL[presence.status]);

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="chat-game-badge"
        aria-label={`${status}: ${presence.game.title} on ${presentation.displayName}`}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <MapThumbnail
          mapName={presence.game.map}
          vault={vault}
          className="chat-game-map"
          placeholderClassName="chat-game-map chat-game-map-placeholder"
        />
      </button>
      {open && createPortal(
        <aside
          id={tooltipId}
          role="tooltip"
          className="chat-game-popover"
          style={position}
        >
          <header className="chat-game-popover-head">
            <div>
              <strong>{presence.game.title || t("chat.game.untitled")}</strong>
              <span>{presentation.displayName}</span>
            </div>
            <span className={`chat-game-status is-${presence.status}`}>{status}</span>
          </header>
          <div className="chat-game-meta">
            <span>{presence.game.modName.toUpperCase()}</span>
            <span>{presence.game.players}/{presence.game.maxPlayers} players</span>
            {presence.game.averageRating > 0 && <span>{presence.game.averageRating} average</span>}
          </div>
          {teams.length > 0 ? (
            <div className="chat-game-teams">
              {teams.map((team) => (
                <section className="chat-game-team surface" key={team.id}>
                  <h4>
                    <span>{team.label} ({team.players.length})</span>
                    {team.rating !== null && <span>{team.rating}</span>}
                  </h4>
                  <ul>
                    {team.players.map((player) => (
                      <li key={player.login}>
                        {player.country ? (
                          <img
                            src={flagSrc(player.country)}
                            alt={player.country.toUpperCase()}
                            width={16}
                            height={16}
                            decoding="async"
                            draggable={false}
                            onError={(event) => { event.currentTarget.style.visibility = "hidden"; }}
                          />
                        ) : <span className="chat-game-flag-placeholder" />}
                        <span>{player.login}</span>
                        {player.rating !== null && <small>({player.rating})</small>}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className="chat-game-no-teams muted">{t("chat.game.noLineup")}</p>
          )}
        </aside>,
        document.body,
      )}
    </>
  );
}
