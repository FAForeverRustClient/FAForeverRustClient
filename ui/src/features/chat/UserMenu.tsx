// Right-click menu for a chat user.
//
// Without this the webview falls back to its own browser menu ("Reload", "Save
// as", "Inspect"), which is meaningless here. The entries are the intersection
// of the two reference clients' player menus: the Java client's
// `ChatUserItemController.onContextMenuRequested` and the Python client's
// `PlayerContextMenu`: narrowed to actions this client can actually perform:
//
//   Java + Python           here
//   ─────────────────────   ────────────────────────────────────────
//   SendPrivateMessage      Private message
//   CopyUsername            Copy username
//   JoinGame                Join game        (only when they host an open one)
//   WatchGame               Watch live       (only when they're in a live game)
//   ViewReplays             View replays     (opens the Replays tab)
//   InvitePlayer            Invite to party  (only when they're free)
//   Add/RemoveFriend        Add/Remove friend
//   Add/RemoveFoe           Add/Remove foe
//   KickFromParty (Python)  Kick from party  (only when we own the party)
//
// Avatar picker, clan-leader messages, and moderator powers remain omitted
// because they need separate backend flows. Player notes are local persisted
// preferences and are available for every resolved FAF account.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Game, PlayerProfile } from "../../ipc/bindings";
import { DEFAULT_COLOR_PICKER_VALUE } from "../../shared/nameColors";
import { useTranslation } from "../../i18n/useTranslation";

/** Gap kept between the menu and the viewport edge when it has to flip. */
const VIEWPORT_MARGIN = 8;

export interface UserMenuTarget {
  nickname: string;
  profile: PlayerProfile | undefined;
  x: number;
  y: number;
}

export interface UserMenuActions {
  privateMessage: (nickname: string) => void;
  copyUsername: (nickname: string) => void;
  viewProfile: (playerId: number | null, nickname: string) => void;
  joinGame: (game: Game) => void;
  watchGame: (game: Game) => void;
  viewReplays: (username: string) => void;
  inviteToParty: (playerId: number) => void;
  setRelation: (profile: PlayerProfile, relation: "friend" | "foe", member: boolean) => void;
  kickFromParty: (playerId: number) => void;
  setNameColor: (nickname: string, color: string | null) => void;
  setMuted: (nickname: string, muted: boolean) => void;
  reportPlayer: (profile: PlayerProfile) => void;
  editNote: (profile: PlayerProfile) => void;
}

interface Props {
  target: UserMenuTarget;
  /** Our own nickname: most actions make no sense pointed at ourselves. */
  self: string;
  isFriend: boolean;
  isFoe: boolean;
  isMuted: boolean;
  /** An open game this player hosts, if any. */
  hostedGame: Game | undefined;
  /** A live game this player is in, if any. */
  liveGame: Game | undefined;
  /** Whether we can invite: we're not them, and they're not already with us. */
  canInvite: boolean;
  /** Whether we own the party and they're in it. */
  canKickFromParty: boolean;
  nameColor: string | undefined;
  actions: UserMenuActions;
  onClose: () => void;
}

type Entry =
  | { kind: "separator" }
  | { kind: "item"; label: string; onSelect: () => void; danger?: boolean };

export function UserMenu({
  target,
  self,
  isFriend,
  isFoe,
  isMuted,
  hostedGame,
  liveGame,
  canInvite,
  canKickFromParty,
  nameColor,
  actions,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: target.x, y: target.y });

  const { nickname, profile } = target;
  const isSelf = !!self && nickname.localeCompare(self, undefined, { sensitivity: "accent" }) === 0;

  const entries: Entry[] = [];
  const item = (label: string, onSelect: () => void, danger?: boolean) =>
    entries.push({ kind: "item", label, onSelect, danger });
  const separator = () => {
    if (entries.length > 0 && entries[entries.length - 1].kind !== "separator") {
      entries.push({ kind: "separator" });
    }
  };

  // Ordered as agreed on the thread, most used first. "View profile" is top
  // because the menu opens under the pointer: whatever is first is what the
  // cursor is already sitting on, and looking somebody up is what a
  // right-click on a name is usually for. Private message is second, since
  // the double-click on the name is the shorter way to that one anyway.
  item(t("chat.menu.viewProfile"), () => actions.viewProfile(profile?.id ?? null, nickname));
  if (!isSelf) item(t("chat.menu.privateMessage"), () => actions.privateMessage(nickname));
  item(t("chat.menu.copyUsername"), () => actions.copyUsername(nickname));

  // What they are doing now, and what they have done. All of it needs a FAF
  // account: an IRC-only nickname has no games and no note to keep.
  if (profile) {
    separator();
    if (hostedGame) item(t("chat.menu.joinGame"), () => actions.joinGame(hostedGame));
    if (liveGame) item(t("chat.menu.watchLive"), () => actions.watchGame(liveGame));
    item(t("chat.menu.viewReplays"), () => actions.viewReplays(profile.login || nickname));
    item(t("chat.menu.editNote"), () => actions.editNote(profile));
  }

  // How you stand with them. Muting is the one entry here that works without
  // an account, because it acts on the nickname the channel shows.
  if (!isSelf) {
    separator();
    if (profile) {
      if (canInvite) item(t("chat.menu.inviteToParty"), () => actions.inviteToParty(profile.id));
      item(t(isFriend ? "chat.menu.removeFriend" : "chat.menu.addFriend"), () =>
        actions.setRelation(profile, "friend", !isFriend),
      );
      item(t(isFoe ? "chat.menu.removeFoe" : "chat.menu.addFoe"), () =>
        actions.setRelation(profile, "foe", !isFoe),
      );
    }
    item(t(isMuted ? "chat.menu.unmute" : "chat.menu.mute"), () =>
      actions.setMuted(nickname, !isMuted),
    );
    if (profile && canKickFromParty) {
      item(t("chat.menu.kickFromParty"), () => actions.kickFromParty(profile.id), true);
    }
  }

  if (profile && !isSelf) {
    separator();
    item(t("chat.menu.reportPlayer"), () => actions.reportPlayer(profile), true);
  }

  // Keep the menu on screen: flip rather than clip when it would overflow.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const maxX = viewportWidth - width - VIEWPORT_MARGIN;
    const maxY = viewportHeight - height - VIEWPORT_MARGIN;
    setPosition({
      x: Math.max(VIEWPORT_MARGIN, Math.min(target.x, maxX)),
      y: Math.max(VIEWPORT_MARGIN, Math.min(target.y, maxY)),
    });
  }, [target.x, target.y]);

  // Dismiss on anything that isn't a click inside the menu.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="chat-user-menu"
      role="menu"
      aria-label={t("chat.menu.aria", { nickname })}
      style={{ left: position.x, top: position.y }}
      // A right-click inside the menu must not open the webview's own menu.
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* No name across the top. It was the first thing in a menu opened on a
          name that is still on screen, still under the pointer, and now kept
          highlighted for exactly this reason: a row of read-only text between
          the cursor and the first action it could reach. */}
      {entries.map((entry, i) =>
        entry.kind === "separator" ? (
          <hr key={`sep-${i}`} className="chat-user-menu-separator" />
        ) : (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            className={`chat-user-menu-item${entry.danger ? " is-danger" : ""}`}
            onClick={() => {
              entry.onSelect();
              onClose();
            }}
          >
            {entry.label}
          </button>
        ),
      )}
      {/* Last, because it is a setting rather than an action: it is reached
          deliberately, once, and never in a hurry. */}
      <hr className="chat-user-menu-separator" />
      <div className="chat-user-menu-color" role="group" aria-label={t("chat.menu.nameColorGroup", { nickname })}>
        <label>
          <span>{t("chat.menu.customColor")}</span>
          <input
            type="color"
            value={nameColor ?? DEFAULT_COLOR_PICKER_VALUE}
            aria-label={t("chat.menu.chooseColor", { nickname })}
            onChange={(event) => actions.setNameColor(nickname, event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!nameColor}
          onClick={() => actions.setNameColor(nickname, null)}
        >
          {t("chat.menu.clear")}
        </button>
      </div>
    </div>
  );
}
