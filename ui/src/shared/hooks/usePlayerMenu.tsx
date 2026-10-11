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
import { PlayerNoteModal } from "../components/PlayerNoteEditor";
import { UserMenu, type UserMenuTarget } from "../components/UserMenu";
// The menu's styling lives in the chat stylesheet, which a non-chat caller
// would otherwise never load.
import { joinGame as joinLobbyGame } from "../joinGame";

/** Open the menu for `nickname`, anchored at the pointer. */
export type PlayerMenuOpener = (nickname: string, event: MouseEvent) => void;

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
  /**
   * How "Join game" joins. The Play tab passes its own, which asks for a
   * password first when the lobby has one.
   */
  joinGame?: (game: Game) => void;
}

export function usePlayerMenu(options: PlayerMenuOptions = {}): {
  openPlayerMenu: PlayerMenuOpener;
  playerMenu: ReactNode;
  /**
   * Whose menu is open, or `null`.
   *
   * The menu no longer prints the name across its top, so the name it belongs
   * to has to stay legible where it already is: a caller marks the row it
   * opened the menu from and keeps it looking hovered. Without that the menu
   * appears under the pointer, which has by then left the row, and nothing on
   * screen says which of two hundred names it is about.
   */
  playerMenuTarget: string | null;
} {
  const social = useAppStore((s) => s.state.social);
  const player = useAppStore((s) => s.state.auth.player);
  const chatUsername = useAppStore((s) => s.state.chat.username);
  const games = useAppStore((s) => s.state.lobby.games);
  const liveGames = useAppStore((s) => s.state.lobby.liveGames);
  const party = useAppStore((s) => s.state.lobby.party);
  const chatPreferences = useAppStore((s) => s.state.settings.chat);
  const playerNotes = useAppStore((s) => s.state.settings.social.playerNotes);
  const [menu, setMenu] = useState<UserMenuTarget | null>(null);
  const [noteTarget, setNoteTarget] = useState<AccountRef | null>(null);

  const self = chatUsername || player?.name || "";

  const openPlayerMenu = useCallback<PlayerMenuOpener>((nickname, event) => {
    // Replace the webview's own context menu, which offers "Reload"/"Inspect".
    event.preventDefault();
    const social = useAppStore.getState().state.social;
    setMenu({
      nickname,
      profile: findPlayer(social, nickname),
      x: event.clientX,
      y: event.clientY,
    });
    // Somebody offline: the online list has no id for them, and friend, foe,
    // note and report all address the account by id. Asked once per name;
    // the menu offers those entries greyed out until the answer is in.
    if (accountFor(social, nickname) === undefined) {
      ipc.send({ kind: "Social", command: { type: "lookUpLogin", payload: { login: nickname } } });
    }
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);

  const openConversation = useCallback((nick: string) => {
    if (!nick) return;
    ipc.send({ kind: "Chat", command: { type: "joinChannel", payload: { channel: nick } } });
    ipc.send({ kind: "Chat", command: { type: "selectChannel", payload: { channel: nick } } });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "chat" } } });
  }, []);

  const viewReplays = useCallback((username: string) => {
    requestReplaySearch({ ...EMPTY_REPLAY_QUERY, player: username, exactPlayer: true });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "replays" } } });
  }, []);

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

  const playerMenu = (
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
            viewProfile: (playerId, nickname) => void openPlayerCard(playerId, nickname),
            copyUsername: (nickname) => void navigator.clipboard?.writeText(nickname),
            joinGame: (game) => void (options.joinGame ?? joinGame)(game),
            watchGame: (game) => void watchGame(game),
            viewReplays,
            inviteToParty: (id) => void inviteToParty(id),
            setRelation: (account, relation, member) => void setRelation(account, relation, member),
            kickFromParty: (id) => void kickFromParty(id),
            setNameColor: setPlayerNameColor,
            setMuted: setPlayerMuted,
            editNote: setNoteTarget,
            reportPlayer: (account) => ipc.send({
              kind: "Reporting",
              command: { type: "open", payload: { playerId: account.id, login: account.login } },
            }),
          }}
          onClose={closeMenu}
        />
      )}
      {noteTarget && (
        <PlayerNoteModal
          playerId={noteTarget.id}
          login={noteTarget.login}
          initialNote={noteForPlayer(playerNotes, noteTarget.id)}
          onClose={() => setNoteTarget(null)}
        />
      )}
    </>
  );

  // `openPlayerMenu` is stable, so a caller can pass it through a `memo`'d row
  // without defeating the memo; only the rendered node changes per render.
  return { openPlayerMenu, playerMenu, playerMenuTarget: menu?.nickname ?? null };
}
