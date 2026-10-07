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
//
// Everything that acts on the account is offered whether the player is online
// or not. Friend, foe, note and report address the account by id, which the
// online list has and a replay lineup does not, so for somebody offline the
// caller looks the login up and passes `account`; until the answer is in those
// entries are shown greyed out rather than left out, so the menu does not
// change shape under the pointer. Only what needs them online (join, watch,
// invite, kick) depends on presence.
//
// No "Mute player": the foe list is the one way to stop hearing from somebody,
// as in both reference clients, with Settings > Chat > "Hide foe messages"
// deciding whether a foe's messages are shown. Somebody muted before that
// change can still be unmuted here.

import { ColorInput } from "../../design-system/ColorInput";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Game, PlayerProfile } from "../../ipc/bindings";
import type { AccountRef } from "../../store/reducers/social";
import { DEFAULT_COLOR_PICKER_VALUE } from "./nameColors";
import { useTranslation } from "../../i18n/useTranslation";
import "./user-menu.css";

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
  setRelation: (account: AccountRef, relation: "friend" | "foe", member: boolean) => void;
  kickFromParty: (playerId: number) => void;
  setNameColor: (nickname: string, color: string | null) => void;
  setMuted: (nickname: string, muted: boolean) => void;
  reportPlayer: (account: AccountRef) => void;
  editNote: (account: AccountRef) => void;
}

interface Props {
  target: UserMenuTarget;
  /**
   * The FAF account behind the name: the online profile's, or a lookup's
   * answer for somebody offline. `undefined` while the lookup is out, `null`
   * when there is no such account (an IRC-only nickname).
   */
  account: AccountRef | null | undefined;
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
  | { kind: "item"; label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; hint?: string };

export function UserMenu({
  target,
  account,
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
  const item = (label: string, onSelect: () => void, danger?: boolean, hint?: string) =>
    entries.push({ kind: "item", label, onSelect, danger, hint });
  // An entry that acts on the account: offered for anybody with one, greyed
  // out while an offline player's account is still being looked up.
  const accountItem = (label: string, act: (known: AccountRef) => void, danger?: boolean, hint?: string) => {
    if (account === null) return;
    entries.push({
      kind: "item",
      label,
      onSelect: () => {
        if (account) act(account);
      },
      danger,
      disabled: account === undefined,
      hint: account === undefined ? t("chat.menu.lookingUp") : hint,
    });
  };
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

  // What they are doing now, and what they have done. Join and watch need
  // them online; replays and the note need only the account, so an IRC-only
  // nickname gets neither.
  separator();
  if (profile && hostedGame) item(t("chat.menu.joinGame"), () => actions.joinGame(hostedGame));
  if (profile && liveGame) item(t("chat.menu.watchLive"), () => actions.watchGame(liveGame));
  if (account !== null) item(t("chat.menu.viewReplays"), () => actions.viewReplays(account?.login || nickname));
  accountItem(t("chat.menu.editNote"), (known) => actions.editNote(known));

  // How you stand with them. Invite and kick act on the party, so they need
  // them online; friend and foe act on the account.
  if (!isSelf) {
    separator();
    if (profile && canInvite) item(t("chat.menu.inviteToParty"), () => actions.inviteToParty(profile.id));
    accountItem(t(isFriend ? "chat.menu.removeFriend" : "chat.menu.addFriend"), (known) =>
      actions.setRelation(known, "friend", !isFriend),
    );
    accountItem(
      t(isFoe ? "chat.menu.removeFoe" : "chat.menu.addFoe"),
      (known) => actions.setRelation(known, "foe", !isFoe),
      false,
      isFoe ? undefined : t("chat.menu.foeHint"),
    );
    if (isMuted) item(t("chat.menu.unmute"), () => actions.setMuted(nickname, false));
    if (profile && canKickFromParty) {
      item(t("chat.menu.kickFromParty"), () => actions.kickFromParty(profile.id), true);
    }
  }

  if (!isSelf && account !== null) {
    separator();
    accountItem(t("chat.menu.reportPlayer"), (known) => actions.reportPlayer(known), true);
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

  // Rendered into `document.body`, the way every other floating layer in this
  // client is. It is `position: fixed` and was not, which is fine for as long
  // as it is only ever opened from the channel roster: nothing between the
  // roster and the root paints over it. It is opened from a replay's lineup
  // now, and that lineup lives in a modal, so the menu was being drawn inside
  // the workspace *behind* the panel it belongs to and nothing in it could be
  // clicked. A portal takes every ancestor out of the question: no stacking
  // context between here and the root, and no `overflow` to be clipped by.
  const menu = (
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
            disabled={entry.disabled}
            title={entry.hint}
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
          <ColorInput
            className="chat-user-menu-color-swatch"
            showSwatch
            value={nameColor ?? DEFAULT_COLOR_PICKER_VALUE}
            aria-label={t("chat.menu.chooseColor", { nickname })}
            onChange={(next) => actions.setNameColor(nickname, next)}
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

  return typeof document === "undefined" ? menu : createPortal(menu, document.body);
}
