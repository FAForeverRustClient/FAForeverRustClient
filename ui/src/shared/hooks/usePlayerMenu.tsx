// The player context menu, as a hook any view can hang off a nickname.
//
// The menu itself ([`UserMenu`]) and everything it needs to decide what to
// offer, whether we can invite this player, whether they host something
// joinable, what colour their name is, started life inline in `ChatView`. The
// live-replay tab wants exactly the same menu on the names in a game's lineup,
// and a second copy of a thirty-entry decision table is not a thing worth
// having, so the wiring moved here.
//
// Nothing about it is chat-specific: it reads the same `social`, `lobby` and
// `settings` slices from anywhere, and its actions are ordinary commands.
// `privateMessage` opens the conversation *and* switches to the chat tab,
// which is a no-op for a caller already there and the whole point for one that
// isn't.

import { useCallback, useState, type MouseEvent, type ReactNode } from "react";
import { ipc } from "../../ipc/client";
import type { Game } from "../../ipc/bindings";
import { findPlayer } from "../../store/reducer";
import { accountFor, type AccountRef } from "../../store/reducers/social";
import { useAppStore } from "../../store/store";
import { assignedPlayerColor, includesName } from "../nameColorsUtil";
import { setPlayerMuted, setPlayerNameColor } from "../preferenceCommands";
import { noteForPlayer } from "../rules/playerNotes";
import { EMPTY_REPLAY_QUERY } from "../replayQuery";
import { requestReplaySearch } from "../replaySearchIntent";
import { openPlayerCard } from "../playerCardActions";
import { openReport } from "../reportIntent";
import { PlayerNoteModal } from "../components/PlayerNoteEditor";
import { UserMenu, type UserMenuTarget } from "../components/UserMenu";
// The menu's styling lives in the chat stylesheet, which a non-chat caller
// would otherwise never load.
import { joinGame as joinLobbyGame } from "../joinGame";

/** What the place a menu was opened from knows about the name. */
export interface PlayerMenuContext {
  /** The game the name was shown in, which "Report" fills in for the user. */
  gameId?: number;
}

/** Open the menu for `nickname`, beside the element it was opened from. */
export type PlayerMenuOpener = (nickname: string, event: MouseEvent, context?: PlayerMenuContext) => void;

/**
 * `opener` with the game a lineup belongs to attached, so a report opened from
 * a replay's names arrives with its game ID filled in (issue 614).
 */
export function withGameContext(opener: PlayerMenuOpener, gameId: number): PlayerMenuOpener {
  return (nickname, event) => opener(nickname, event, { gameId });
}

const setRelation = (account: AccountRef, relation: "friend" | "foe", member: boolean) =>
  ipc.send({
    kind: "Social",
    command: {
      type: "setRelation",
      payload: { playerId: account.id, login: account.login, relation, member },
    },
  });
const inviteToParty = (playerId: number) =>
  ipc.send({ kind: "Lobby", command: { type: "inviteToParty", payload: { playerId } } });
const kickFromParty = (playerId: number) =>
  ipc.send({ kind: "Lobby", command: { type: "kickPartyMember", payload: { playerId } } });
const joinGame = (game: Game) =>
  void joinLobbyGame(game.id);
const watchGame = (game: Game) =>
  ipc.send({
    kind: "Replays",
    command: { type: "watchLive", payload: { uid: game.id, modName: game.modName, map: game.map } },
  });

/** Which game in `list` this player is in, if any. */
const inGame = (list: Game[], nickname: string) =>
  list.find((game) => Object.values(game.teams).some((team) => team.includes(nickname)));

export interface PlayerMenuOptions {
  /** Close a source dialog when an action opens another view. */
  onNavigate?: () => void;
  /**
   * How "Join game" joins. The Play tab passes its own, which asks for a
   * password first when the lobby has one.
   */
  joinGame?: (game: Game) => void;
  /**
   * Opened from the player card: "View profile" would only reopen the page
   * the menu was opened on, so it is left out.
   */
  fromProfile?: boolean;
}

export function usePlayerMenu(options: PlayerMenuOptions = {}): {
  openPlayerMenu: PlayerMenuOpener;
  playerMenu: ReactNode;
  /**
   * Whose menu is open, or `null`.
   *
   * The menu no longer prints the name across its top, so the name it belongs
   * to has to stay legible where it already is: a caller marks the row it
   * opened the menu from and keeps it looking hovered while the pointer
   * moves into the menu, so its source remains clear in a long list.
   */
  playerMenuTarget: string | null;
} {
  // Only what is open, and to whom. The live data the menu draws from is read
  // by `PlayerMenuLayer`, which exists while something is open: fourteen
  // views offer this menu, and each of them used to redraw on every lobby
  // and social update with the menu closed.
  const [menu, setMenu] = useState<UserMenuTarget | null>(null);
  const [menuContext, setMenuContext] = useState<PlayerMenuContext>({});
  const [noteTarget, setNoteTarget] = useState<AccountRef | null>(null);

  const openPlayerMenu = useCallback<PlayerMenuOpener>((nickname, event, context) => {
    // Replace the webview's own context menu, which offers "Reload"/"Inspect".
    event.preventDefault();
    setMenuContext(context ?? {});
    const social = useAppStore.getState().state.social;
    const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
    setMenu({
      nickname,
      profile: findPlayer(social, nickname),
      x: event.clientX,
      y: event.clientY,
      anchor: { left, right, top, bottom },
    });
    // Somebody offline: the online list has no id for them, and friend, foe,
    // note and report all address the account by id. Asked once per name;
    // the menu offers those entries greyed out until the answer is in.
    if (accountFor(social, nickname) === undefined) {
      ipc.send({ kind: "Social", command: { type: "lookUpLogin", payload: { login: nickname } } });
    }
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const closeNote = useCallback(() => setNoteTarget(null), []);

  const playerMenu = menu || noteTarget ? (
    <PlayerMenuLayer
      menu={menu}
      menuContext={menuContext}
      noteTarget={noteTarget}
      options={options}
      onCloseMenu={closeMenu}
      onEditNote={setNoteTarget}
      onCloseNote={closeNote}
    />
  ) : null;

  // `openPlayerMenu` is stable, so a caller can pass it through a `memo`'d row
  // without defeating the memo; only the rendered node changes per render.
  return { openPlayerMenu, playerMenu, playerMenuTarget: menu?.nickname ?? null };
}

/** The open menu and note editor, subscribed to what they show. */
function PlayerMenuLayer({ menu, menuContext, noteTarget, options, onCloseMenu, onEditNote, onCloseNote }: {
  menu: UserMenuTarget | null;
  menuContext: PlayerMenuContext;
  noteTarget: AccountRef | null;
  options: PlayerMenuOptions;
  onCloseMenu: () => void;
  onEditNote: (account: AccountRef) => void;
  onCloseNote: () => void;
}) {
  const social = useAppStore((s) => s.state.social);
  const player = useAppStore((s) => s.state.auth.player);
  const chatUsername = useAppStore((s) => s.state.chat.username);
  const games = useAppStore((s) => s.state.lobby.games);
  const liveGames = useAppStore((s) => s.state.lobby.liveGames);
  const party = useAppStore((s) => s.state.lobby.party);
  const chatPreferences = useAppStore((s) => s.state.settings.chat);
  const playerNotes = useAppStore((s) => s.state.settings.social.playerNotes);
  const onNavigate = options.onNavigate;

  const self = chatUsername || player?.name || "";

  const openConversation = useCallback((nick: string) => {
    if (!nick) return;
    onNavigate?.();
    ipc.send({ kind: "Chat", command: { type: "joinChannel", payload: { channel: nick } } });
    ipc.send({ kind: "Chat", command: { type: "selectChannel", payload: { channel: nick } } });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "chat" } } });
  }, [onNavigate]);

  const viewReplays = useCallback((username: string) => {
    onNavigate?.();
    requestReplaySearch({ ...EMPTY_REPLAY_QUERY, player: username, exactPlayer: true });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "replays" } } });
  }, [onNavigate]);

  // Which game the menu's target is in, from the lists the Play tab already
  // keeps: `player_info` doesn't carry a game, but `game_info` carries rosters.
  const inParty = (id: number) => party.members.some((member) => member.playerId === id);
  const menuHostedGame = menu && games.find((game) => game.host === menu.nickname);
  const menuLiveGame = menu ? inGame(liveGames, menu.nickname) : undefined;
  const menuNameColor = menu
    ? assignedPlayerColor(chatPreferences.nameColors.players, menu.nickname)
    : undefined;
  const menuIsMuted = !!menu && includesName(chatPreferences.mutedPlayers, menu.nickname);
  // Read on every render, so the lookup's answer lands in the open menu.
  const menuAccount = menu ? accountFor(social, menu.nickname) : undefined;

  return (
    <>
      {menu && (
        <UserMenu
          target={menu}
          account={menuAccount}
          self={self}
          isFriend={includesName(social.friends, menuAccount?.login || menu.nickname)}
          isFoe={includesName(social.foes, menuAccount?.login || menu.nickname)}
          isMuted={menuIsMuted}
          hostedGame={menuHostedGame ?? undefined}
          liveGame={menuLiveGame}
          canInvite={!!menu.profile && !inParty(menu.profile.id)}
          canKickFromParty={
            !!menu.profile &&
            party.ownerId === (player?.id ?? -1) &&
            inParty(menu.profile.id)
          }
          nameColor={menuNameColor}
          actions={{
            privateMessage: openConversation,
            viewProfile: options.fromProfile ? undefined : (playerId, nickname) => { options.onNavigate?.(); void openPlayerCard(playerId, nickname); },
            copyUsername: (nickname) => void navigator.clipboard?.writeText(nickname),
            joinGame: (game) => { options.onNavigate?.(); void (options.joinGame ?? joinGame)(game); },
            watchGame: (game) => { options.onNavigate?.(); void watchGame(game); },
            viewReplays,
            inviteToParty: (id) => void inviteToParty(id),
            setRelation: (account, relation, member) => void setRelation(account, relation, member),
            kickFromParty: (id) => void kickFromParty(id),
            setNameColor: setPlayerNameColor,
            setMuted: setPlayerMuted,
            editNote: onEditNote,
            reportPlayer: (account) => { options.onNavigate?.(); openReport(account, menuContext.gameId); },
          }}
          onClose={onCloseMenu}
        />
      )}
      {noteTarget && (
        <PlayerNoteModal
          playerId={noteTarget.id}
          login={noteTarget.login}
          initialNote={noteForPlayer(playerNotes, noteTarget.id)}
          onClose={onCloseNote}
        />
      )}
    </>
  );
}
