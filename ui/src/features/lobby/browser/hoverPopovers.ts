// The one lineup popover and the one friends/foes popover the browser shows
// at a time: which game they are open for, where, and the hover grace that
// keeps them from flickering as the pointer crosses a gap.

import { useEffect, useId, useSyncExternalStore } from "react";
import {
  hoverCloseDelay,
  hoverOpenDelay,
  hoverPanelsEnabled,
  noteHoverPanelClosed,
  noteHoverPanelOpen,
} from "../../../shared/hoverPanels";

export type TooltipPosition = { left?: number; right?: number; top?: number; bottom?: number };

type ActiveLineup = {
  gameId: number;
  position: TooltipPosition;
} | null;

/** One overlay exists at a time, so one id is enough. See `shared/hoverPanels`. */
const LINEUP_PANEL_ID = "lobby-game-lineup";

let activeLineup: ActiveLineup = null;
const lineupListeners = new Set<() => void>();

function subscribeLineup(listener: () => void) {
  lineupListeners.add(listener);
  return () => {
    lineupListeners.delete(listener);
  };
}

export function getActiveLineupSnapshot() {
  return activeLineup;
}

export function hideGlobalLineup() {
  cancelLineupHide();
  cancelLineupShow();
  if (activeLineup !== null) {
    noteHoverPanelClosed(LINEUP_PANEL_ID);
    activeLineup = null;
    for (const listener of lineupListeners) {
      listener();
    }
  }
}

/**
 * How long the overlay survives the pointer leaving it.
 *
 * The overlay is interactive -- the player names in it open profile cards --
 * and reaching it means crossing the gap between the row and the overlay, which
 * is a `mouseleave` with nothing under the pointer. Closing on that would make
 * the overlay unreachable, so leaving starts a timer instead and arriving
 * anywhere that counts cancels it.
 *
 * A preference rather than a constant since #264: a second was too long and
 * scanning the list left the overlay trailing the pointer, a sixth of a second
 * suits people who want to reach the overlay, and neither suits everybody. See
 * `shared/hoverPanels`, which also owns the delay before it opens.
 */
let lineupHideTimer: ReturnType<typeof setTimeout> | null = null;
let lineupShowTimer: ReturnType<typeof setTimeout> | null = null;

/** Stop a pending close: the pointer arrived somewhere that keeps it open. */
export function cancelLineupHide() {
  if (lineupHideTimer !== null) {
    clearTimeout(lineupHideTimer);
    lineupHideTimer = null;
  }
}

/** The pointer left. Close, unless it comes back within the grace period. */
export function hideGlobalLineupSoon() {
  cancelLineupHide();
  lineupHideTimer = setTimeout(hideGlobalLineup, hoverCloseDelay());
}

/** Drop a pending open: the pointer left before the delay was up. */
function cancelLineupShow() {
  if (lineupShowTimer !== null) {
    clearTimeout(lineupShowTimer);
    lineupShowTimer = null;
  }
}

/**
 * Ways the tooltip can be left standing that no `onMouseLeave` covers.
 *
 * It is `position: fixed`, up to 430 by 420 pixels, and its contents are
 * clickable (a player name opens a card), so it cannot simply be made
 * `pointer-events: none`. Left up over the workspace it therefore swallows
 * clicks in that rectangle, which is a candidate for the "unable to click
 * anything" report: rare, cured by a restart, and no error anywhere.
 *
 * Three events that leave it up today: alt-tabbing away, the list scrolling
 * under a stationary pointer, and Escape, which everything else in this client
 * answers. Installed once, on first use, so the listeners cost nothing in a
 * session that never hovers a game.
 */
let lineupGuardsInstalled = false;

function installLineupGuards() {
  if (lineupGuardsInstalled || typeof window === "undefined") return;
  lineupGuardsInstalled = true;
  window.addEventListener("blur", () => {
    hideGlobalLineup();
    hideGlobalSocial();
  });
  // Capture, because the scroll happens on a container rather than on window.
  window.addEventListener("scroll", () => {
    hideGlobalLineup();
    hideGlobalSocial();
  }, true);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideGlobalLineup();
      hideGlobalSocial();
    }
  });
}

export function setGlobalLineup(gameId: number, position: TooltipPosition) {
  installLineupGuards();
  noteHoverPanelOpen(LINEUP_PANEL_ID);
  activeLineup = { gameId, position };
  for (const listener of lineupListeners) {
    listener();
  }
}

// The tooltip is opened by hover and closed by the matching `mouseleave`, so
// anything that takes the pointer away without one leaves it on screen. These
// are those cases.
if (typeof window !== "undefined") {
  window.addEventListener("blur", () => {
    hideGlobalLineup();
    hideGlobalSocial();
  });
  // Coming back matters as much as leaving. Alt-tabbing away with the pointer
  // resting on a tile and moving it elsewhere in another window produces no
  // `mouseleave` here at all, because this window is not receiving the pointer:
  // the tooltip was still up on return, over a tile the pointer had long left.
  //
  // Asking what is hovered rather than closing outright, because the pointer
  // may genuinely still be on the tile: clicking back into the window would
  // otherwise take the tooltip away and, with no `mouseenter` left to fire,
  // not give it back until the pointer had left the tile and returned.
  window.addEventListener("focus", () => {
    if (!document.querySelector(".game-tile:hover, .game-browser-row:hover, .game-friends-popover:hover")) {
      hideGlobalLineup();
      hideGlobalSocial();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hideGlobalLineup();
      hideGlobalSocial();
    }
  });
  window.addEventListener("scroll", () => {
    hideGlobalLineup();
    hideGlobalSocial();
  }, true);
  window.addEventListener("resize", () => {
    hideGlobalLineup();
    hideGlobalSocial();
  });
  document.addEventListener("mouseleave", () => {
    hideGlobalLineup();
    hideGlobalSocial();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      hideGlobalLineup();
      hideGlobalSocial();
    }
  });
}

export function useGameLineupPosition(gameId: number) {
  const tooltipId = useId();
  const currentActive = useSyncExternalStore(subscribeLineup, getActiveLineupSnapshot, () => null);
  const tooltipPosition = currentActive?.gameId === gameId ? currentActive.position : null;

  /**
   * `immediate` is the keyboard path. A delay exists because a pointer crosses
   * rows it did not mean to ask about; tabbing onto a row is never accidental,
   * and waiting half a second after a deliberate keypress reads as a client
   * that has stopped responding.
   */
  const showLineup = (target: HTMLElement, immediate = false) => {
    if (!hoverPanelsEnabled()) return;
    if (activeSocial?.gameId === gameId) return;
    // Moving straight from one row to another: the close the first row asked
    // for must not land on the overlay the second one is opening.
    cancelLineupHide();
    cancelLineupShow();
    // Measured when the delay is up rather than now: the list scrolls and
    // reflows under a resting pointer, and a rectangle half a second old is a
    // rectangle the row has moved out of.
    const open = () => {
      lineupShowTimer = null;
      const bounds = target.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const tooltipWidth = Math.min(430, viewportWidth - 32);
      const halfWidth = tooltipWidth / 2;
      const left = Math.min(
        viewportWidth - 16 - halfWidth,
        Math.max(16 + halfWidth, bounds.left + bounds.width / 2),
      );
      const hasRoomBelow = viewportHeight - bounds.bottom >= 260;
      const position = hasRoomBelow
        ? { left, top: bounds.bottom + 6 }
        : { left, bottom: viewportHeight - bounds.top + 6 };
      setGlobalLineup(gameId, position);
    };
    const delay = immediate ? 0 : hoverOpenDelay();
    if (delay <= 0) {
      open();
      return;
    }
    lineupShowTimer = setTimeout(open, delay);
  };

  // Leaving starts the grace period rather than closing: the overlay is
  // reachable now, and the pointer has to cross a gap to get to it.
  const hideLineup = () => {
    // Also when nothing is open yet: the pointer passing over a row starts the
    // open timer, and leaving before it fires has to call it off. That is the
    // whole point of the delay.
    cancelLineupShow();
    if (currentActive?.gameId === gameId) {
      hideGlobalLineupSoon();
    }
  };


  useEffect(() => {
    return () => {
      if (activeLineup?.gameId === gameId) {
        hideGlobalLineup();
      }
    };
  }, [gameId]);

  return {
    tooltipId,
    tooltipPosition,
    showLineup,
    hideLineup,
  };
}

type ActiveSocial = {
  gameId: number;
  category: "friends" | "foes";
  position: TooltipPosition;
} | null;

let activeSocial: ActiveSocial = null;
const socialListeners = new Set<() => void>();

function subscribeSocial(listener: () => void) {
  socialListeners.add(listener);
  return () => {
    socialListeners.delete(listener);
  };
}

export function getActiveSocialSnapshot() {
  return activeSocial;
}

const SOCIAL_GRACE_MS = 160;
let socialHideTimer: ReturnType<typeof setTimeout> | null = null;

export function cancelSocialHide() {
  if (socialHideTimer !== null) {
    clearTimeout(socialHideTimer);
    socialHideTimer = null;
  }
}

export function hideGlobalSocial() {
  cancelSocialHide();
  if (activeSocial !== null) {
    activeSocial = null;
    for (const listener of socialListeners) {
      listener();
    }
  }
}

export function hideGlobalSocialSoon() {
  cancelSocialHide();
  socialHideTimer = setTimeout(hideGlobalSocial, SOCIAL_GRACE_MS);
}

export function setGlobalSocial(gameId: number, category: "friends" | "foes", position: TooltipPosition) {
  installLineupGuards();
  cancelSocialHide();
  activeSocial = { gameId, category, position };
  for (const listener of socialListeners) {
    listener();
  }
}

export const hideGlobalFriends = hideGlobalSocial;
export const cancelFriendsHide = cancelSocialHide;
export const hideGlobalFriendsSoon = hideGlobalSocialSoon;

export function useGameSocialPosition(gameId: number) {
  const socialPopoverId = useId();
  const currentActive = useSyncExternalStore(subscribeSocial, getActiveSocialSnapshot, () => null);
  const socialCategory = currentActive?.gameId === gameId ? currentActive.category : null;
  const socialPosition = currentActive?.gameId === gameId ? currentActive.position : null;

  const showSocial = (target: HTMLElement, category: "friends" | "foes") => {
    cancelSocialHide();
    hideGlobalLineup();
    const bounds = target.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const popoverWidth = 290;

    const isRightHalf = bounds.left + bounds.width / 2 > viewportWidth / 2;
    const position: TooltipPosition = {};
    if (isRightHalf) {
      position.right = Math.max(16, viewportWidth - bounds.right);
    } else {
      position.left = Math.max(16, Math.min(bounds.left, viewportWidth - 16 - popoverWidth));
    }

    const hasRoomAbove = bounds.top >= 180;
    if (hasRoomAbove) {
      position.bottom = viewportHeight - bounds.top + 6;
    } else {
      position.top = bounds.bottom + 6;
    }
    setGlobalSocial(gameId, category, position);
  };

  const hideSocial = () => {
    if (currentActive?.gameId === gameId) {
      hideGlobalSocialSoon();
    }
  };

  useEffect(() => {
    return () => {
      if (activeSocial?.gameId === gameId) {
        hideGlobalSocial();
      }
    };
  }, [gameId]);

  return {
    socialPopoverId,
    socialCategory,
    socialPosition,
    showSocial,
    hideSocial,
  };
}
