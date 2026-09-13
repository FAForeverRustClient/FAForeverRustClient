import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { PlayerName } from "../../shared/nameColors";
import type { PlayerMenuOpener } from "../chat/usePlayerMenu";
import type { Game, LiveReplayTracking } from "../../ipc/bindings";
import { ipc } from "../../ipc/client";
import { formatClockDuration, formatRelativeDuration } from "../../shared/durations";
import type { MapPresentation } from "../../shared/mapPresentation";
import { liveReplayLink } from "../../shared/replayLinks";
import { gameStartedAt, prettyGameType } from "./liveReplayModel";
import { t } from "../../i18n";
import { useTranslation } from "../../i18n/useTranslation";
import { clientIntlTag } from "../../shared/dates";

export function LiveMapThumbnail({ presentation }: { presentation: MapPresentation }) {
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

/**
 * A nickname in the table, with the client's player menu on it.
 *
 * Both reference clients treat a player's name as the handle on that player
 * wherever it appears; this table showed a lineup you could read and nothing
 * else. Left-click opens the menu as well as right-click, because a name in a
 * table cell does not otherwise advertise that it has one.
 */
export function LivePlayerName({ name, onMenu }: { name: string; onMenu: PlayerMenuOpener }) {
  return (
    <button
      type="button"
      className="live-player-name"
      aria-haspopup="menu"
      onClick={(event) => onMenu(name, event)}
      onContextMenu={(event) => onMenu(name, event)}
    >
      <PlayerName name={name} />
    </button>
  );
}

export function LiveReplayAge({ game, now }: { game: Game; now: number }) {
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

/** Width of the delay menu, mirrored from `.live-delay-menu` in the stylesheet. */
const DELAY_MENU_WIDTH = 190;
/** Gap kept between the menu and both its trigger and the viewport edge. */
const DELAY_MENU_GAP = 4;

export function LiveWatchButton({
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
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });

  const setMenuOpen = useCallback((next: boolean) => {
    setOpen(next);
    onMenuToggle?.(next);
  }, [onMenuToggle]);

  // The menu is rendered into `document.body` rather than into the row.
  //
  // Inside the row it was effectively invisible: the table's scroll container
  // clips it, and the next row's own positioned cells paint over what is left,
  // so clicking "Ready in 1:12" looked like it did nothing at all. No amount
  // of `z-index` on the row fixes that; leaving both the clipping box and the
  // table's paint order does. Fixed coordinates measured from the trigger keep
  // it anchored, flipping above the trigger when there is no room below.
  const place = useCallback(() => {
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!trigger) return;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const height = menuRef.current?.getBoundingClientRect().height ?? 0;
    const below = trigger.bottom + DELAY_MENU_GAP;
    const flip = height > 0 && below + height + DELAY_MENU_GAP > viewportHeight;
    setPosition({
      top: Math.max(DELAY_MENU_GAP, flip ? trigger.top - DELAY_MENU_GAP - height : below),
      // Right-aligned with the trigger, the way the in-row menu was.
      left: Math.max(
        DELAY_MENU_GAP,
        Math.min(trigger.right - DELAY_MENU_WIDTH, viewportWidth - DELAY_MENU_WIDTH - DELAY_MENU_GAP),
      ),
    });
  }, []);

  // Measured once the menu exists, so the flip decision knows its height.
  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const close = () => setMenuOpen(false);
    const handlePointerDown = (event: PointerEvent) => {
      const node = event.target as Node;
      if (menuRef.current?.contains(node) || triggerRef.current?.contains(node)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    // A menu anchored to a row that scrolled away would float over nothing, so
    // it follows the trigger and gives up when the window itself changes size.
    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", close);
    };
  }, [open, place, setMenuOpen]);

  // A game that matured while its menu was open must not leave the menu
  // orphaned above the "Watch" button that replaces the trigger.
  useEffect(() => {
    if (!waiting && open) setMenuOpen(false);
  }, [waiting, open, setMenuOpen]);

  if (waiting) {
    const trackedLabel = t(tracked?.action === "notify"
      ? "replays.live.notificationSet"
      : "replays.live.autoWatchSet");
    const closeMenu = () => setMenuOpen(false);
    return (
      <div className={`live-delay-actions${tracked ? " is-tracked" : ""}`}>
        <button
          ref={triggerRef}
          type="button"
          className="live-delay-trigger"
          title={t("replays.live.delayHint")}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={() => setMenuOpen(!open)}
        >
          {tracked ? trackedLabel : t("replays.live.readyIn", { time: formatClockDuration(waitSeconds) })}
        </button>
        {open && createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            className="live-delay-menu surface-raised"
            style={{ top: position.top, left: position.left }}
          >
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
          </div>,
          document.body,
        )}
      </div>
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
  onPlayerMenu,
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
  onPlayerMenu: PlayerMenuOpener;
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
  // Only where the host set one, and worded the way the Play tab words the
  // same pair, open ends included.
  const ratingRange = game.ratingMin !== null || game.ratingMax !== null
    ? t("lobby.details.ratingRangeValue", {
      from: game.ratingMin ?? t("lobby.details.any"),
      to: game.ratingMax ?? t("lobby.details.any"),
    })
    : null;

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
        <td className="live-host-cell"><LivePlayerName name={game.host} onMenu={onPlayerMenu} /></td>
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
            {/* What the row above does not already say, laid out as a panel
                rather than spread across the width of the table.

                The three columns this used to be were sized by the table, so
                on a wide display the lineup sat at the far left, three
                captions floated somewhere in the middle right, and the one
                button was alone in a corner: a paragraph of facts with the
                whole window between them. Two of those facts (the featured mod
                and the sim mods) were also printed in the row being expanded.

                So: the map this is being played on, the lineup, the handful of
                facts a row has no column for, and the mods in full rather than
                as "and 2 more". */}
            <div className="live-replay-details">
              <div className="live-detail-head">
                <div className="live-detail-map">
                  <LiveMapThumbnail presentation={presentation} />
                  <div className="live-detail-map-name">
                    <strong>{presentation.displayName}</strong>
                    {/* The technical name, which is what somebody looking for
                        the map in the vault or on disk actually searches. */}
                    <code title={game.map}>{game.map}</code>
                  </div>
                </div>
                <Button
                  className="live-copy-link"
                  title={t("replays.live.copyLinkHint")}
                  onClick={() =>
                    ipc.run(
                      navigator.clipboard
                        .writeText(liveReplayLink(game, player))
                        .then(() => setCopied(true)),
                    )
                  }
                >
                  <Icon name={copied ? "check" : "copy"} size={14} />
                  {t(copied ? "replays.live.linkCopied" : "replays.live.copyLink")}
                </Button>
              </div>

              <dl className="live-detail-facts">
                <div>
                  <dt>{t("replays.live.replayId")}</dt>
                  <dd>#{game.id}</dd>
                </div>
                <div>
                  <dt>{t("lobby.details.visibility")}</dt>
                  <dd>
                    {t(game.visibility === "friends"
                      ? "lobby.host.visibility.friends"
                      : "lobby.host.visibility.public")}
                    {game.passwordProtected && ` · ${t("lobby.host.passwordProtected")}`}
                  </dd>
                </div>
                {ratingRange && (
                  <div>
                    <dt>{t("lobby.details.ratingRange")}</dt>
                    <dd>
                      {ratingRange}
                      {game.enforceRatingRange && ` · ${t("replays.live.ratingEnforced")}`}
                    </dd>
                  </div>
                )}
              </dl>

              <div className="live-detail-lineup">
                <span className="live-detail-label">{t("replays.live.lineup")}</span>
                <div className="live-team-list">
                  {teams.length === 0 ? <span className="muted">{t("replays.live.lineupUnavailable")}</span> : teams.map(([team, players]) => (
                    <div className="live-team surface" key={team}>
                      <strong>
                        {team === "-1" || team === "null" ? t("replays.live.observers") : t("replays.live.team", { team })}
                        <span className="live-team-count">{players.length}</span>
                      </strong>
                      <ul className="live-team-players">
                        {players.map((p) => (
                          <li key={p}>
                            <LivePlayerName name={p} onMenu={onPlayerMenu} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>

              {simMods.length > 0 && (
                <div className="live-detail-simmods">
                  <span className="live-detail-label">
                    {t("replays.live.simMods")}
                    <span className="live-detail-count">{simMods.length}</span>
                  </span>
                  <ul className="live-sim-mod-list">
                    {simMods.map((mod) => (
                      <li key={mod} className="surface-chip">{mod}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
});
