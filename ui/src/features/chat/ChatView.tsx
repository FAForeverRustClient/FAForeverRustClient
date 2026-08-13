// Chat tab: the multi-channel IRC client.
//
// Layout follows the reference clients' information architecture in this
// client's quieter shell: channels as a tab strip along the top (the Java
// client's tab pane), the conversation below it with its topic in the header,
// and the roster in a right sidebar grouped the way both clients group it,
// you first, then moderators, friends, other players, and IRC-only nicknames
// last.
//
// All of it is driven by `state.chat` plus `state.social`; this view holds no
// conversation state of its own. The app shell starts the live session after
// account login, and the small fallback below covers a tab mounted before that
// event arrived.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ipc } from "../../ipc/client";
import { noteForPlayer } from "../../shared/playerNotes";
import { useAppStore } from "../../store/store";
import { Icon } from "../../design-system/Icon";
import type { ChatChannel, ChatStatus, Game, PlayerProfile } from "../../ipc/bindings";
import { findPlayer, isPrivateChannel } from "../../store/reducer";
import { ChannelTabs } from "./ChannelTabs";
import type { ChatGameLink } from "./chatFormat";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { visibleChatMessages } from "./messageFilters";
import { RosterResizeHandle, clampRosterWidth } from "./RosterResizeHandle";
import { UserList } from "./UserList";
import { UserMenu, type UserMenuTarget } from "./UserMenu";
import { openPlayerCard } from "../player-card/playerCardActions";
import { PlayerNoteModal } from "../player-card/PlayerNoteEditor";
import "./chat.css";

/** Mirrors `faf_domain::state::chat::DEFAULT_CHANNEL`. */
const DEFAULT_CHANNEL = "#aeolus";

const STATUS_LABEL: Record<ChatStatus, string> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Connected",
};

/**
 * What the header line says about the open conversation.
 *
 * The topic when the channel has one, since that is the thing the tab strip
 * cannot show. Without a topic it falls back to who is here, which the roster
 * also reports: a duplicate is better than a blank row, and IRC channels
 * without a topic are the minority.
 */
function channelContext(channel: ChatChannel | undefined, status: ChatStatus): string {
  if (!channel) return STATUS_LABEL[status];
  if (channel.topic) return channel.topic;
  if (isPrivateChannel(channel.name)) return `Private conversation with ${channel.name}`;
  const count = channel.users.length;
  return `${count} ${count === 1 ? "person" : "people"} online`;
}

const connect = (username: string) =>
  ipc.send({ kind: "Chat", command: { type: "connect", payload: { username } } });
const sendMessage = (channel: string, content: string) =>
  ipc.send({ kind: "Chat", command: { type: "sendMessage", payload: { channel, content } } });
const selectChannel = (channel: string) =>
  ipc.send({ kind: "Chat", command: { type: "selectChannel", payload: { channel } } });
const joinChannel = (channel: string) =>
  ipc.send({ kind: "Chat", command: { type: "joinChannel", payload: { channel } } });
const leaveChannel = (channel: string) =>
  ipc.send({ kind: "Chat", command: { type: "leaveChannel", payload: { channel } } });
// User-menu actions. Friend/foe and party invites travel the lobby socket, the
// same as in both reference clients.
const setRelation = (profile: PlayerProfile, relation: "friend" | "foe", member: boolean) =>
  ipc.send({
    kind: "Social",
    command: {
      type: "setRelation",
      payload: { playerId: profile.id, login: profile.login, relation, member },
    },
  });
const inviteToParty = (playerId: number) =>
  ipc.send({ kind: "Lobby", command: { type: "inviteToParty", payload: { playerId } } });
const kickFromParty = (playerId: number) =>
  ipc.send({ kind: "Lobby", command: { type: "kickPartyMember", payload: { playerId } } });
const joinGame = (game: Game) =>
  ipc.send({ kind: "Lobby", command: { type: "join", payload: { id: game.id, password: null } } });
const watchGame = (game: Game) =>
  ipc.send({
    kind: "Replays",
    command: { type: "watchLive", payload: { uid: game.id, modName: game.modName, map: game.map } },
  });
const openTab = (tab: "replays") =>
  ipc.send({ kind: "Nav", command: { type: "select", payload: { tab } } });

export function ChatView() {
  const state = useAppStore((s) => s.state.chat);
  const social = useAppStore((s) => s.state.social);
  const player = useAppStore((s) => s.state.auth.player);
  const games = useAppStore((s) => s.state.lobby.games);
  const liveGames = useAppStore((s) => s.state.lobby.liveGames);
  const mapVault = useAppStore((s) => s.state.maps.vault);
  const party = useAppStore((s) => s.state.lobby.party);
  const chatPreferences = useAppStore((s) => s.state.settings.chat);
  const playerNotes = useAppStore((s) => s.state.settings.social.playerNotes);
  const [menu, setMenu] = useState<UserMenuTarget | null>(null);
  const [noteTarget, setNoteTarget] = useState<PlayerProfile | null>(null);
  const [searchRequest, setSearchRequest] = useState(0);
  const [gameLinkNotice, setGameLinkNotice] = useState("");
  const [rosterWidth, setRosterWidth] = useState(() => clampRosterWidth(chatPreferences.rosterWidth));

  // Fallback for a very early tab mount; deliberately not keyed on status, so
  // a user-initiated disconnect doesn't reconnect.
  useEffect(() => {
    const s = useAppStore.getState().state;
    if (s.chat.status === "disconnected" && s.auth.player) {
      void connect(s.auth.player.name);
    }
  }, []);

  useEffect(() => {
    setRosterWidth(clampRosterWidth(chatPreferences.rosterWidth));
  }, [chatPreferences.rosterWidth]);

  useEffect(() => {
    if (!gameLinkNotice) return;
    const timeout = window.setTimeout(() => setGameLinkNotice(""), 5_000);
    return () => window.clearTimeout(timeout);
  }, [gameLinkNotice]);

  const active = useMemo(
    () => state.channels.find((c) => c.name === state.activeChannel) ?? state.channels[0],
    [state.channels, state.activeChannel],
  );

  const isLive = state.status === "connected" || state.status === "connecting";
  const self = state.username || player?.name || "";

  // Channel commentary (joins, parts, quits, topic changes) is filtered here
  // rather than dropped on arrival, so flipping the preference reveals history
  // that already exists: the Python client's `joinsparts` behaviour without
  // its "you had to have it on at the time" cost.
  const messages = useMemo(() => {
    if (!active) return [];
    return visibleChatMessages(active.messages, chatPreferences, social);
  }, [active, chatPreferences, social]);

  const nicknames = useMemo(() => active?.users.map((u) => u.name) ?? [], [active]);

  const openConversation = useCallback((nick: string) => {
    if (!nick || nick === self) return;
    void joinChannel(nick);
    void selectChannel(nick);
  }, [self]);

  const openMenu = useCallback((nickname: string, event: React.MouseEvent) => {
    // Replace the webview's own context menu, which offers "Reload"/"Inspect".
    event.preventDefault();
    setMenu({
      nickname,
      profile: findPlayer(useAppStore.getState().state.social, nickname),
      x: event.clientX,
      y: event.clientY,
    });
  }, []);
  const closeMenu = useCallback(() => setMenu(null), []);
  const commitRosterWidth = useCallback((width: number) => {
    const preferences = useAppStore.getState().state.settings.chat;
    if (preferences.rosterWidth === width) return;
    ipc.send({
      kind: "Settings",
      command: { type: "setChat", payload: { preferences: { ...preferences, rosterWidth: width } } },
    });
  }, []);

  const setPlayerNameColor = useCallback((nickname: string, color: string | null) => {
    const preferences = useAppStore.getState().state.settings.chat;
    const players = Object.fromEntries(
      Object.entries(preferences.nameColors.players)
        .filter(([player]) => player.localeCompare(nickname, undefined, { sensitivity: "accent" }) !== 0),
    );
    if (color) players[nickname] = color;
    ipc.send({
      kind: "Settings",
      command: {
        type: "setChat",
        payload: {
          preferences: {
            ...preferences,
            nameColors: { ...preferences.nameColors, players },
          },
        },
      },
    });
  }, []);

  const setMuted = useCallback((nickname: string, muted: boolean) => {
    const preferences = useAppStore.getState().state.settings.chat;
    const withoutPlayer = preferences.mutedPlayers.filter(
      (player) => player.localeCompare(nickname, undefined, { sensitivity: "accent" }) !== 0,
    );
    ipc.send({
      kind: "Settings",
      command: {
        type: "setChat",
        payload: {
          preferences: {
            ...preferences,
            mutedPlayers: muted ? [...withoutPlayer, nickname] : withoutPlayer,
          },
        },
      },
    });
  }, []);

  // Which game the menu's target is in, from the lists the Play tab already
  // keeps: `player_info` doesn't carry a game, but `game_info` carries rosters.
  const inGame = (list: Game[], nickname: string) =>
    list.find((g) => Object.values(g.teams).some((team) => team.includes(nickname)));
  const menuHostedGame = menu && games.find((g) => g.host === menu.nickname);
  const menuLiveGame = menu ? inGame(liveGames, menu.nickname) : undefined;
  const inParty = (id: number) => party.members.some((m) => m.playerId === id);
  const menuNameColor = menu
    ? Object.entries(chatPreferences.nameColors.players)
        .find(([nickname]) => nickname.localeCompare(menu.nickname, undefined, { sensitivity: "accent" }) === 0)?.[1]
    : undefined;
  const menuIsMuted = !!menu && chatPreferences.mutedPlayers.some(
    (player) => player.localeCompare(menu.nickname, undefined, { sensitivity: "accent" }) === 0,
  );

  const activateGameLink = useCallback((link: ChatGameLink) => {
    const game = (link.kind === "openGame" ? games : liveGames)
      .find((candidate) => candidate.id === link.uid);
    if (!game) {
      setGameLinkNotice("That game is no longer available.");
      return;
    }
    setGameLinkNotice("");
    if (link.kind === "openGame") void joinGame(game);
    else void watchGame(game);
  }, [games, liveGames]);

  const userMenu = menu && (
        <UserMenu
          target={menu}
          self={self}
          isFriend={social.friends.includes(menu.nickname)}
          isFoe={social.foes.includes(menu.nickname)}
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
            joinGame: (game) => void joinGame(game),
            watchGame: (game) => void watchGame(game),
            viewReplays: () => void openTab("replays"),
            inviteToParty: (id) => void inviteToParty(id),
            setRelation: (profile, relation, member) =>
              void setRelation(profile, relation, member),
            kickFromParty: (id) => void kickFromParty(id),
            setNameColor: setPlayerNameColor,
            setMuted,
            editNote: setNoteTarget,
            reportPlayer: (profile) => ipc.send({
              kind: "Reporting",
              command: { type: "open", payload: { playerId: profile.id, login: profile.login } },
            }),
          }}
          onClose={closeMenu}
        />
  );

  const chatStyle = { "--chat-roster-width": `${rosterWidth}px` } as CSSProperties;

  return (
    <div className="chat" style={chatStyle}>
      <section className="chat-main">
        <ChannelTabs
          channels={state.channels}
          active={active?.name ?? ""}
          defaultChannel={DEFAULT_CHANNEL}
          onSelect={(c) => void selectChannel(c)}
          onJoin={(c) => void joinChannel(c)}
          onLeave={(c) => void leaveChannel(c)}
        />

        {/* The strip above already names the channel, so this row carries only
            what it does not: the topic, and the controls that act on the
            conversation. */}
        <header className="chat-head">
          <p className="chat-topic" title={active?.topic || undefined}>
            {channelContext(active, state.status)}
          </p>
          <span className="spacer" />
          {gameLinkNotice && <span className="chat-link-notice" role="status">{gameLinkNotice}</span>}
          <button type="button" className="chat-head-action" onClick={() => setSearchRequest((request) => request + 1)}>
            <Icon name="search" size={14} /> Search
          </button>
          <label className="chat-toggle">
            <input
              type="checkbox"
              checked={chatPreferences.showJoinsParts}
              onChange={(event) => ipc.send({
                kind: "Settings",
                command: {
                  type: "setChat",
                  payload: {
                    preferences: { ...chatPreferences, showJoinsParts: event.target.checked },
                  },
                },
              })}
            />
            Joins &amp; parts
          </label>
        </header>

        {active ? (
          <MessageList
            key={active.name}
            messages={messages}
            self={self}
            emptyLabel={
              isLive
                ? "No messages yet."
                : "Not connected: messages will appear once you're online."
            }
            onNickClick={openConversation}
            onNickContextMenu={openMenu}
            showTimestamps={chatPreferences.showTimestamps}
            use24HourTime={chatPreferences.use24HourTime}
            users={active.users}
            social={social}
            preferences={chatPreferences}
            searchRequest={searchRequest}
            onGameLink={activateGameLink}
          />
        ) : (
          <div className="chat-scroll-wrap">
            <p className="muted chat-empty">
              <Icon name="chat" size={18} /> {STATUS_LABEL[state.status]}
            </p>
          </div>
        )}

        <Composer
          channel={active?.name ?? DEFAULT_CHANNEL}
          nicknames={nicknames}
          disabled={!isLive || !active}
          onSend={(content) => void sendMessage(active?.name ?? DEFAULT_CHANNEL, content)}
        />
      </section>

      {active && !isPrivateChannel(active.name) && (
        <div className="chat-roster-shell">
          <RosterResizeHandle
            width={rosterWidth}
            onResize={setRosterWidth}
            onCommit={commitRosterWidth}
          />
          <UserList
            users={active.users}
            self={self}
            social={social}
            openGames={games}
            liveGames={liveGames}
            mapVault={mapVault}
            preferences={chatPreferences}
            onOpenConversation={openConversation}
            onContextMenu={openMenu}
          />
        </div>
      )}

      {userMenu}
      {noteTarget && (
        <PlayerNoteModal
          playerId={noteTarget.id}
          login={noteTarget.login}
          initialNote={noteForPlayer(playerNotes, noteTarget.id)}
          onClose={() => setNoteTarget(null)}
        />
      )}
    </div>
  );
}
