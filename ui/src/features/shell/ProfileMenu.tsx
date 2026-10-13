// Right-click menu on the player's own name in the sidebar (#514).
//
// Signing out and starting the game offline both lived in Settings only, and
// a right-click on one's own name is where people looked for them first. The
// sidebar has no room for two more buttons, so they are here, beside the two
// entries the same name offers everywhere else (profile, copy).
//
// Built from the player menu's parts: its look (`chat-user-menu`), its
// placement beside what opened it, and its way of closing, so the two menus
// cannot drift apart.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { OverlayParentContext, useOverlayLayer } from "../../design-system/useOverlayLayer";
import { restoreFocus } from "../../design-system/overlayStack";
import { useTranslation } from "../../i18n/useTranslation";
import { menuPosition, type MenuAnchor } from "../../shared/rules/menuPosition";
import "../../shared/components/user-menu.css";

export interface ProfileMenuTarget {
  x: number;
  y: number;
  anchor?: MenuAnchor;
}

interface Props {
  target: ProfileMenuTarget;
  name: string;
  onViewProfile: () => void;
  onCopyName: () => void;
  onPlayOffline: () => void;
  onLogOut: () => void;
  onClose: () => void;
}

export function ProfileMenu({ target, name, onViewProfile, onCopyName, onPlayOffline, onLogOut, onClose }: Props) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Opened from the keyboard as well as the mouse: the first entry takes
    // focus, so the arrow-free menu is still reachable with Tab.
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  const layer = useOverlayLayer(true, () => {
    onClose();
    restoreFocus(previousFocus.current);
  }, { elementRef: menuRef });
  const [position, setPosition] = useState<{ x: number; y: number; maxHeight?: number }>({ x: target.x, y: target.y });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    setPosition(menuPosition(target, target.anchor, { width, height }, { width: viewportWidth, height: viewportHeight }));
  }, [target]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const entry = (label: string, act: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={`chat-user-menu-item${danger ? " is-danger" : ""}`}
      onClick={() => {
        act();
        onClose();
      }}
    >
      {label}
    </button>
  );

  const menu = (
    <OverlayParentContext.Provider value={layer}>
      <div
        ref={menuRef}
        className="chat-user-menu"
        role="menu"
        aria-label={t("shell.profileMenu.aria", { name })}
        style={{ left: position.x, top: position.y, maxHeight: position.maxHeight }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {entry(t("chat.menu.viewProfile"), onViewProfile)}
        {entry(t("chat.menu.copyUsername"), onCopyName)}
        <hr className="chat-user-menu-separator" />
        {entry(t("auth.playOffline"), onPlayOffline)}
        <hr className="chat-user-menu-separator" />
        {entry(t("settings.account.logOut"), onLogOut, true)}
      </div>
    </OverlayParentContext.Provider>
  );

  return typeof document === "undefined" ? menu : createPortal(menu, document.body);
}
