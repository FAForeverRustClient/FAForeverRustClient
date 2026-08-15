import { Fragment, memo, useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { PlayerName } from "../../shared/nameColors";
import type { Game, LiveReplayTracking } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { formatClockDuration, formatRelativeDuration } from "../../shared/durations";
import type { MapPresentation } from "../../shared/mapPresentation";
import { liveReplayLink } from "../../shared/replayLinks";
import { gameStartedAt, prettyGameType } from "./liveReplayModel";

function LiveMapThumbnail({ presentation }: { presentation: MapPresentation }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [presentation.thumbnailUrl]);

  return presentation.thumbnailUrl && !failed ? (
    <img
      className="live-replay-map-thumb"
      src={presentation.thumbnailUrl}
      alt={`${presentation.displayName} preview`}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  ) : (
    <span className="live-replay-map-placeholder" aria-hidden="true">
      <Icon name="maps" size={18} />
    </span>
  );
}

function LiveReplayAge({ game, now }: { game: Game; now: number }) {
  const started = gameStartedAt(game);
  if (!started) return <small>Start time unavailable</small>;
  const elapsed = Math.max(0, (now - started.getTime()) / 1000);
  return <small>{formatRelativeDuration(elapsed, { nowLabel: "0m ago", suffix: " ago" })}</small>;
}

function LiveWatchButton({
  busy,
  game,
  tracking,
  waitSeconds,
}: {
  busy: boolean;
  game: Game;
  tracking: LiveReplayTracking | null;
  waitSeconds: number;
}) {
  const waiting = waitSeconds > 0;
  const tracked = tracking?.target.uid === game.id ? tracking : null;
  const target = { uid: game.id, modName: game.modName, map: game.map };

  if (waiting) {
    const trackedLabel = tracked?.action === "notify" ? "Notification set" : "Auto-watch set";
    return (
      <details className={`live-delay-actions${tracked ? " is-tracked" : ""}`}>
        <summary
          className="live-delay-trigger"
          title="The replay server makes live streams available after five minutes."
        >
          {tracked ? trackedLabel : `Ready in ${formatClockDuration(waitSeconds)}`}
        </summary>
        <div className="live-delay-menu surface-raised">
          <strong>When the replay is ready</strong>
          <Button
            disabled={busy || tracked?.action === "notify"}
            onClick={() => ipc.send({
              kind: "Replays",
              command: { type: "trackLive", payload: { target, action: "notify" } },
            })}
          >
            Notify me
          </Button>
          <Button
            disabled={busy || tracked?.action === "watch"}
            onClick={() => ipc.send({
              kind: "Replays",
              command: { type: "trackLive", payload: { target, action: "watch" } },
            })}
          >
            Watch automatically
          </Button>
          {tracked && (
            <Button onClick={() => ipc.send({ kind: "Replays", command: { type: "cancelLiveTracking" } })}>
              Cancel
            </Button>
          )}
        </div>
      </details>
    );
  }

  return (
    <Button
      variant="primary"
      className="live-watch-button"
      disabled={busy}
      title={`Watch ${game.title}`}
      onClick={() =>
        ipc.send({
          kind: "Replays",
          command: {
            type: "watchLive",
            payload: target,
          },
        })
      }
    >
      Watch
    </Button>
  );
}

export const LiveReplayRow = memo(function LiveReplayRow({
  busy,
  expanded,
  game,
  ageNow,
  waitSeconds,
  onToggle,
  presentation,
  player,
  tracking,
}: {
  busy: boolean;
  expanded: boolean;
  game: Game;
  ageNow: number;
  waitSeconds: number;
  onToggle: (id: number) => void;
  presentation: MapPresentation;
  player: string;
  tracking: LiveReplayTracking | null;
}) {
  const [copied, setCopied] = useState(false);
  const started = gameStartedAt(game);
  const simMods = Object.values(game.simMods);
  const teams = Object.entries(game.teams).filter(([, players]) => players.length > 0);

  return (
    <>
      <tr
        className={expanded ? "live-replay-row expanded" : "live-replay-row"}
        onDoubleClick={() => {
          if (!busy && waitSeconds <= 0) {
            ipc.send({
              kind: "Replays",
              command: {
                type: "watchLive",
                payload: {
                  uid: game.id,
                  modName: game.modName,
                  map: game.map,
                },
              },
            });
          }
        }}
      >
        <td><LiveMapThumbnail presentation={presentation} /></td>
        <td className="live-start-cell">
          <strong>{started ? started.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "N/A"}</strong>
          <LiveReplayAge game={game} now={ageNow} />
        </td>
        <td>
          <button className="live-game-title" onClick={() => onToggle(game.id)} aria-expanded={expanded}>
            <strong>{game.title || presentation.displayName}</strong>
            <small>{presentation.displayName} · {prettyGameType(game.gameType)}</small>
          </button>
        </td>
        <td className="live-number-cell"><strong>{game.players}</strong><small>/ {game.maxPlayers}</small></td>
        <td className="live-rating-cell">{game.averageRating > 0 ? game.averageRating : "N/A"}</td>
        <td className="live-host-cell"><PlayerName name={game.host} /></td>
        <td className="live-mods-cell">
          <span>{game.modName || "faf"}</span>
          <small title={simMods.join(", ")}>
            {simMods.length === 0 ? "No SIM mods" : simMods.length === 1 ? simMods[0] : `${simMods[0]} +${simMods.length - 1}`}
          </small>
        </td>
        <td><LiveWatchButton busy={busy} game={game} tracking={tracking} waitSeconds={waitSeconds} /></td>
      </tr>
      {expanded && (
        <tr className="live-replay-detail-row">
          <td colSpan={8}>
            <div className="live-replay-details">
              <div>
                <span className="live-detail-label">Lineup</span>
                <div className="live-team-list">
                  {teams.length === 0 ? <span className="muted">Player lineup unavailable</span> : teams.map(([team, players]) => (
                    <div className="live-team surface" key={team}>
                      <strong>{team === "-1" || team === "null" ? "Observers" : `Team ${team}`}</strong>
                      <span>
                        {players.map((p, i) => (
                          <Fragment key={p}>
                            {i > 0 && ", "}
                            <PlayerName name={p} />
                          </Fragment>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="live-detail-side">
                <dl className="live-detail-meta">
                  <div><dt>Replay ID</dt><dd>#{game.id}</dd></div>
                  <div><dt>Featured mod</dt><dd>{game.modName || "faf"}</dd></div>
                  <div><dt>SIM mods</dt><dd>{simMods.length > 0 ? simMods.join(", ") : "None"}</dd></div>
                </dl>
                <Button
                  className="live-copy-link"
                  onClick={() =>
                    ipc.run(
                      navigator.clipboard
                        .writeText(liveReplayLink(game, player))
                        .then(() => setCopied(true)),
                    )
                  }
                >
                  {copied ? "Link copied" : "Copy live link"}
                </Button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
});
