import { Fragment, memo, useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { PlayerName } from "../../shared/nameColors";
import type { Game, LiveReplayTracking } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { formatClockDuration, formatRelativeDuration } from "../../shared/durations";
import type { MapPresentation } from "../../shared/mapPresentation";
import { liveReplayLink } from "../../shared/replayLinks";
import { gameStartedAt, prettyGameType } from "./liveReplayModel";
import { t } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { clientIntlTag } from "../../shared/dates";

function LiveMapThumbnail({ presentation }: { presentation: MapPresentation }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [presentation.thumbnailUrl]);

  return presentation.thumbnailUrl && !failed ? (
    <img
      className="live-replay-map-thumb"
      src={presentation.thumbnailUrl}
      alt={t("replays.live.mapPreview", { map: presentation.displayName })}
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
  const { t } = useTranslation();
  const started = gameStartedAt(game);
  if (!started) return <small>{t("replays.live.startUnavailable")}</small>;
  const elapsed = Math.max(0, (now - started.getTime()) / 1000);
  // A live game is always "some time ago", so the zero case reads as `0m` in
  // the same phrase rather than as its own wording.
  const zero = t("replays.card.ago", { duration: "0m" });
  const relative = formatRelativeDuration(elapsed, { nowLabel: zero });
  return <small>{relative === zero ? relative : t("replays.card.ago", { duration: relative })}</small>;
}

function LiveWatchButton({
  busy,
  game,
  tracking,
  waitSeconds,
  onMenuToggle,
}: {
  busy: boolean;
  game: Game;
  tracking: LiveReplayTracking | null;
  waitSeconds: number;
  onMenuToggle?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const waiting = waitSeconds > 0;
  const tracked = tracking?.target.uid === game.id ? tracking : null;
  const target = { uid: game.id, modName: game.modName, map: game.map };
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (detailsRef.current && !detailsRef.current.contains(event.target as Node)) {
        detailsRef.current.removeAttribute("open");
        setOpen(false);
        onMenuToggle?.(false);
      }
    };
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open, onMenuToggle]);

  const closeMenu = () => {
    if (detailsRef.current) {
      detailsRef.current.removeAttribute("open");
    }
    setOpen(false);
    onMenuToggle?.(false);
  };

  if (waiting) {
    const trackedLabel = t(tracked?.action === "notify"
      ? "replays.live.notificationSet"
      : "replays.live.autoWatchSet");
    return (
      <details
        ref={detailsRef}
        className={`live-delay-actions${tracked ? " is-tracked" : ""}`}
        onToggle={(e) => {
          const isOpen = e.currentTarget.open;
          setOpen(isOpen);
          onMenuToggle?.(isOpen);
        }}
      >
        <summary
          className="live-delay-trigger"
          title={t("replays.live.delayHint")}
        >
          {tracked ? trackedLabel : t("replays.live.readyIn", { time: formatClockDuration(waitSeconds) })}
        </summary>
        <div className="live-delay-menu surface-raised">
          <strong>{t("replays.live.whenReady")}</strong>
          <Button
            disabled={busy || tracked?.action === "notify"}
            onClick={() => {
              ipc.send({
                kind: "Replays",
                command: { type: "trackLive", payload: { target, action: "notify" } },
              });
              closeMenu();
            }}
          >
            {t("replays.live.notifyMe")}
          </Button>
          <Button
            disabled={busy || tracked?.action === "watch"}
            onClick={() => {
              ipc.send({
                kind: "Replays",
                command: { type: "trackLive", payload: { target, action: "watch" } },
              });
              closeMenu();
            }}
          >
            {t("replays.live.watchAutomatically")}
          </Button>
          {tracked && (
            <Button
              onClick={() => {
                ipc.send({ kind: "Replays", command: { type: "cancelLiveTracking" } });
                closeMenu();
              }}
            >
              {t("replays.live.cancelTracking")}
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
      title={t("replays.live.watchTitle", { title: game.title })}
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
      {t("replays.live.watch")}
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
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const started = gameStartedAt(game);
  const simMods = Object.values(game.simMods);
  const teams = Object.entries(game.teams).filter(([, players]) => players.length > 0);

  return (
    <>
      <tr
        className={`live-replay-row${expanded ? " expanded" : ""}${menuOpen ? " is-menu-open" : ""}`}
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
          <strong>{started ? started.toLocaleTimeString(clientIntlTag(), { hour: "2-digit", minute: "2-digit" }) : "N/A"}</strong>
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
            {simMods.length === 0
              ? t("replays.live.noSimMods")
              : simMods.length === 1
                ? simMods[0]
                : t("replays.live.moreSimMods", { first: simMods[0], count: simMods.length - 1 })}
          </small>
        </td>
        <td className="live-watch-column-cell">
          <LiveWatchButton
            busy={busy}
            game={game}
            tracking={tracking}
            waitSeconds={waitSeconds}
            onMenuToggle={setMenuOpen}
          />
        </td>
      </tr>
      {expanded && (
        <tr className="live-replay-detail-row">
          <td colSpan={8}>
            <div className="live-replay-details">
              <div>
                <span className="live-detail-label">{t("replays.live.lineup")}</span>
                <div className="live-team-list">
                  {teams.length === 0 ? <span className="muted">{t("replays.live.lineupUnavailable")}</span> : teams.map(([team, players]) => (
                    <div className="live-team surface" key={team}>
                      <strong>{team === "-1" || team === "null" ? t("replays.live.observers") : t("replays.live.team", { team })}</strong>
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
                  <div><dt>{t("replays.live.replayId")}</dt><dd>#{game.id}</dd></div>
                  <div><dt>{t("replays.live.featuredMod")}</dt><dd>{game.modName || "faf"}</dd></div>
                  <div><dt>{t("replays.live.simMods")}</dt><dd>{simMods.length > 0 ? simMods.join(", ") : t("replays.live.none")}</dd></div>
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
                  {t(copied ? "replays.live.linkCopied" : "replays.live.copyLink")}
                </Button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
});
