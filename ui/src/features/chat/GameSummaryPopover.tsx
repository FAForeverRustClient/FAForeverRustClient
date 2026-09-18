import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SocialState, VaultMap } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { MapThumbnail } from "../../shared/MapThumbnail";
import { mapPresentation } from "../../shared/mapPresentation";
import { type GamePresence } from "./gameSummary";
import { GameSummaryCard, STATUS_LABEL } from "./GameSummaryCard";
import { GameStatusSword } from "./GameStatusSword";
import { useTranslation } from "../../i18n/useTranslation";
import { joinGame } from "../lobby/joinGame";
import {
  hoverCloseDelay,
  hoverOpenDelay,
  hoverPanelsEnabled,
  noteHoverPanelClosed,
  noteHoverPanelOpen,
} from "../../shared/hoverPanels";

interface Props {
  presence: GamePresence;
  social: SocialState;
  vault: VaultMap[];
}

export function GameSummaryPopover({ presence, social, vault }: Props) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 8, right: 8 });
  const anchor = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const openTimer = useRef<number | undefined>(undefined);
  const tooltipId = useId();
  const presentation = mapPresentation(vault, presence.game.map);

  // The delays are the ones Settings, Appearance holds: see
  // `shared/hoverPanels`. The card is interactive, so the closing one is not
  // decoration: without it the gap between the badge and the card closes it and
  // the button inside can never be clicked.
  const show = useCallback((immediate = false) => {
    if (!hoverPanelsEnabled()) return;
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(openTimer.current);
    const reveal = () => {
      noteHoverPanelOpen(tooltipId);
      setOpen(true);
    };
    // `immediate` is the keyboard path: tabbing onto the badge is never
    // accidental, so it is not what the delay is protecting against.
    const delay = immediate ? 0 : hoverOpenDelay();
    if (delay <= 0) {
      reveal();
      return;
    }
    openTimer.current = window.setTimeout(reveal, delay);
  }, [tooltipId]);
  const hide = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      noteHoverPanelClosed(tooltipId);
      setOpen(false);
    }, hoverCloseDelay());
  }, [tooltipId]);
  useEffect(() => () => {
    window.clearTimeout(closeTimer.current);
    window.clearTimeout(openTimer.current);
    noteHoverPanelClosed(tooltipId);
  }, [tooltipId]);

  const updatePosition = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    setPosition({
      top: Math.max(8, Math.min(rect.top, viewportHeight - 280)),
      right: Math.max(8, viewportWidth - rect.left + 8),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    const handleClose = () => setOpen(false);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("blur", handleClose);
    document.addEventListener("visibilitychange", handleClose);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("blur", handleClose);
      document.removeEventListener("visibilitychange", handleClose);
    };
  }, [open, updatePosition]);

  // Only the one card currently visible needs a clock, and only while it is
  // open: a several-hundred-user channel must not run a timer per badge.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    if (!open) return;
    setNow(Math.floor(Date.now() / 1000));
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const { t } = useTranslation();
  const status = t(STATUS_LABEL[presence.status]);

  const watching = presence.status === "playing" || presence.status === "playingDelayed";
  const act = () => {
    if (watching) {
      ipc.send({
        kind: "Replays",
        command: {
          type: "watchLive",
          payload: {
            uid: presence.game.id,
            modName: presence.game.modName,
            map: presence.game.map,
          },
        },
      });
    } else {
      void joinGame(presence.game.id);
    }
  };

  const handleDoubleClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    act();
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="chat-game-badge"
        aria-label={t("chat.gameBadge.aria", {
          status,
          title: presence.game.title,
          map: presentation.displayName,
        })}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={() => show()}
        onMouseLeave={hide}
        onFocus={() => show(true)}
        onBlur={hide}
        onDoubleClick={handleDoubleClick}
      >
        <GameStatusSword status={presence.status} />
        <MapThumbnail
          mapName={presence.game.map}
          vault={vault}
          className="chat-game-map"
          placeholderClassName="chat-game-map chat-game-map-placeholder"
          preferCanonicalPreview
        />
      </button>
      {open && createPortal(
        <aside
          id={tooltipId}
          role="tooltip"
          className="chat-game-popover"
          style={position}
          onMouseEnter={() => show()}
          onMouseLeave={hide}
        >
          {/* The same card the conversation aside shows, thumbnail and all: it
              was the one place the two drifted, and a hover card that is a
              cut-down copy of a panel three pixels away is just a second
              design. */}
          <GameSummaryCard presence={presence} social={social} vault={vault} now={now} showMap />
          {/* The card is reachable now, so the action the double-click on the
              badge performs is spelled out here too. Nothing about a pair of
              crossed swords says "double-click me to spectate". */}
          <footer className="chat-game-popover-foot">
            <button type="button" className="chat-head-action" onClick={act}>
              <Icon name={watching ? "eye" : "play"} size={14} />
              {watching ? t("chat.aside.watch") : t("chat.aside.join")}
            </button>
          </footer>
        </aside>,
        document.body,
      )}
    </>
  );
}
