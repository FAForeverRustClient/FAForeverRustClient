import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { PlayerName } from "../../../shared/components/nameColors";
import type { PlayerMenuOpener } from "../../../shared/hooks/usePlayerMenu";
import type { Game, LiveReplayTracking } from "../../../ipc/bindings";
import { ipc } from "../../../ipc/client";
import { formatClockDuration, formatRelativeDuration, zeroMinutes } from "../../../shared/format/durations";
import type { MapPresentation } from "../../../shared/mapPresentation";
import { gameStartedAt, prettyGameType } from "../../../shared/liveReplayModel";
import { useAppStore } from "../../../store/store";
import { MapThumbnail } from "../../../shared/components/MapThumbnail";
import { useNamedMapGeneration } from "../../../shared/hooks/useNamedMapGeneration";
import { useTranslation } from "../../../i18n/useTranslation";
import { hourCycleOptions } from "../../../shared/format/clock";
import { clientIntlTag } from "../../../shared/format/dates";

/**
 * A running game's map, as the rest of the client draws maps.
 *
 * It used to read only the vault's thumbnail URL, so a generated map stayed a
 * grey placeholder here even after its preview had been made, and nothing in
 * the list offered to make one: "generate a mapgen preview in live replays"
 * (issue 298) only ever reached the detail dialog. `MapThumbnail` knows the
 * generated previews, the campaign missions and the vault, and the button on
 * top makes the preview, the way the chat's hover card does.
 */
export function LiveMapThumbnail({
  mapName,
  presentation,
}: {
  mapName: string;
  presentation: MapPresentation;
}) {
  const vault = useAppStore((state) => state.state.maps.vault);
  return (
    <span className="live-map-thumb-wrap">
      <MapThumbnail
        mapName={mapName}
        vault={vault}
        url={presentation.thumbnailUrl}
        className="live-replay-map-thumb"
        placeholderClassName="live-replay-map-thumb live-replay-map-placeholder"
        iconSize={18}
      />
      <LiveMapGenerateButton mapName={mapName} />
    </span>
  );
}

/**
 * "Generate map" on a live game's thumbnail, for a generated map that is not
 * on disk yet. Nothing for any other map.
 *
 * The row acts on a click (open, watch), so the button keeps its clicks to
 * itself. The cards use `ReplayThumbGenerate`, the vault cards' button.
 */
export function LiveMapGenerateButton({ mapName }: { mapName: string }) {
  const mapGen = useNamedMapGeneration(mapName);
  if (!mapGen.canGenerate && !mapGen.isGenerating) return null;
  return (
    <button
      type="button"
      className="live-map-generate"
      disabled={mapGen.isGenerating}
      title={mapGen.generateLabel}
      aria-label={mapGen.generateLabel}
      onClick={(event) => {
        event.stopPropagation();
        mapGen.generate();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <Icon
        name={mapGen.isGenerating ? "refresh" : "plus"}
        size={12}
        className={mapGen.isGenerating ? "spin" : undefined}
      />
    </button>
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
  return <small>{liveReplayAgeLabel(game, now, t)}</small>;
}

/** How long ago a running game started, as `LiveReplayAge` says it. */
export function liveReplayAgeLabel(game: Game, now: number, t: ReturnType<typeof useTranslation>["t"]): string {
  const started = gameStartedAt(game);
  if (!started) return t("replays.live.startUnavailable");
  const elapsed = Math.max(0, (now - started.getTime()) / 1000);
  // A live game is always "some time ago", so the zero case reads as `0m` in
  // the same phrase rather than as its own wording.
  const zero = t("replays.card.ago", { duration: zeroMinutes() });
  const relative = formatRelativeDuration(elapsed, { nowLabel: zero });
  return relative === zero ? relative : t("replays.card.ago", { duration: relative });
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
  game,
  ageNow,
  waitSeconds,
  onOpen,
  onPlayerMenu,
  presentation,
  mapSize,
  tracking,
  order,
}: {
  busy: boolean;
  game: Game;
  ageNow: number;
  waitSeconds: number;
  /** Opens the game's detail window, the one a card in the grid opens. */
  onOpen: (id: number) => void;
  onPlayerMenu: PlayerMenuOpener;
  presentation: MapPresentation;
  /** "10 km", or null when nothing knows it. */
  mapSize: string | null;
  tracking: LiveReplayTracking | null;
  /** The designed column drawn at each position, as the header draws them. */
  order: readonly number[];
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const mapLabel = mapSize ? `${presentation.displayName} (${mapSize})` : presentation.displayName;
  const started = gameStartedAt(game);
  const simMods = Object.values(game.simMods);
  // The cells in designed order, drawn in the stored one, as the header
  // draws its own.
  const cells = [
    <td key={0}><LiveMapThumbnail mapName={game.map} presentation={presentation} /></td>,
    <td key={1} className="live-start-cell">
      <strong>{started ? started.toLocaleTimeString(clientIntlTag(), { hour: "2-digit", minute: "2-digit", ...hourCycleOptions() }) : t("common.notAvailable")}</strong>
      <LiveReplayAge game={game} now={ageNow} />
    </td>,
    <td key={2}>
      {/* Opens the same window a card in the grid opens, which is the
          vault's detail window: one place for everything about a game,
          whichever way the tab is being read. */}
      <button className="live-game-title" onClick={() => onOpen(game.id)} aria-haspopup="dialog">
        <strong>{game.title || presentation.displayName}</strong>
        <small>{mapLabel} · {prettyGameType(game.gameType)}</small>
      </button>
    </td>,
    <td key={3} className="live-number-cell"><strong>{game.players}</strong><small>/ {game.maxPlayers}</small></td>,
    <td key={4} className="live-rating-cell">{game.averageRating > 0 ? game.averageRating : t("common.notAvailable")}</td>,
    <td key={5} className="live-host-cell"><LivePlayerName name={game.host} onMenu={onPlayerMenu} /></td>,
    <td key={6} className="live-mods-cell">
      <span>{game.modName || "faf"}</span>
      <small title={simMods.join(", ")}>
        {simMods.length === 0
          ? t("replays.live.noSimMods")
          : simMods.length === 1
            ? simMods[0]
            : t("replays.live.moreSimMods", { first: simMods[0], count: simMods.length - 1 })}
      </small>
    </td>,
    <td key={7} className="live-watch-column-cell">
      <LiveWatchButton
        busy={busy}
        game={game}
        tracking={tracking}
        waitSeconds={waitSeconds}
        onMenuToggle={setMenuOpen}
      />
    </td>,
  ];

  return (
      <tr
        className={`live-replay-row${menuOpen ? " is-menu-open" : ""}`}
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
        {order.map((column) => cells[column])}
      </tr>
  );
});
