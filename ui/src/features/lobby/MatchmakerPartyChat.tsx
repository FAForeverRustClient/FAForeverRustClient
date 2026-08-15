import { useEffect, useMemo, useState } from "react";
import { ipc } from "../../ipc/client";
import type { Game, PartyState } from "../../ipc/bindings";
import { useAppStore } from "../../store/store";
import { Composer } from "../chat/Composer";
import { MessageList } from "../chat/MessageList";
import type { ChatGameLink } from "../chat/chatFormat";
import { visibleChatMessages } from "../chat/messageFilters";
import { partyChatChannel } from "./partyChat";
import "../chat/chat.css";
import { useTranslation } from "../../i18n/useTranslation";

export function MatchmakerPartyChat({ party }: { party: PartyState }) {
  const { t } = useTranslation();
  const chat = useAppStore((state) => state.state.chat);
  const social = useAppStore((state) => state.state.social);
  const preferences = useAppStore((state) => state.state.settings.chat);
  const player = useAppStore((state) => state.state.auth.player);
  const games = useAppStore((state) => state.state.lobby.games);
  const liveGames = useAppStore((state) => state.state.lobby.liveGames);
  const [gameLinkNotice, setGameLinkNotice] = useState("");
  const roomName = partyChatChannel(party);
  const room = roomName
    ? chat.channels.find((channel) => channel.name.localeCompare(
        roomName,
        undefined,
        { sensitivity: "accent" },
      ) === 0)
    : undefined;
  const messages = useMemo(
    () => visibleChatMessages(room?.messages ?? [], preferences, social),
    [preferences, room?.messages, social],
  );
  const self = chat.username || player?.name || "";
  useEffect(() => {
    if (!gameLinkNotice) return;
    const timeout = window.setTimeout(() => setGameLinkNotice(""), 5_000);
    return () => window.clearTimeout(timeout);
  }, [gameLinkNotice]);

  const activateGameLink = (link: ChatGameLink) => {
    const game = (link.kind === "openGame" ? games : liveGames)
      .find((candidate) => candidate.id === link.uid);
    if (!game) {
      setGameLinkNotice(t("chat.gameLink.unavailable"));
      return;
    }
    setGameLinkNotice("");
    if (link.kind === "openGame") {
      ipc.send({ kind: "Lobby", command: { type: "join", payload: { id: game.id, password: null } } });
    } else {
      watchGame(game);
    }
  };
  const openConversation = (nickname: string) => {
    if (!nickname || nickname === self) return;
    ipc.send({ kind: "Chat", command: { type: "joinChannel", payload: { channel: nickname } } });
    ipc.send({ kind: "Chat", command: { type: "selectChannel", payload: { channel: nickname } } });
    ipc.send({ kind: "Nav", command: { type: "select", payload: { tab: "chat" } } });
  };

  // `partyChatChannel` returns null for a solo party on purpose: a one-person
  // party must not open a private-looking IRC room. The panel still renders, so
  // the feature is discoverable, but it says what it is waiting for instead of
  // showing an inert message list.
  if (!roomName) {
    return (
      <aside className="matchmaker-party-chat is-empty" aria-label={t("lobby.matchmaker.partyChat")}>
        <header>
          <strong>{t("lobby.matchmaker.partyChat")}</strong>
        </header>
        <p className="muted">
          Invite someone to your party and this becomes a private room for
          agreeing factions and queues before you search.
        </p>
      </aside>
    );
  }

  return (
    <aside className="matchmaker-party-chat" aria-label={t("lobby.matchmaker.partyChat")}>
      <header>
        <strong>{t("lobby.matchmaker.partyChat")}</strong>
        <span>{gameLinkNotice || roomName}</span>
      </header>
      <MessageList
        key={room?.name ?? roomName ?? "party-chat"}
        messages={messages}
        self={self}
        emptyLabel={t(room ? "lobby.party.noMessages" : "lobby.party.joiningChannel")}
        onNickClick={openConversation}
        onNickContextMenu={(nickname, event) => {
          event.preventDefault();
          openConversation(nickname);
        }}
        showTimestamps={preferences.showTimestamps}
        use24HourTime={preferences.use24HourTime}
        users={room?.users ?? []}
        social={social}
        preferences={preferences}
        onGameLink={activateGameLink}
      />
      <Composer
        channel={roomName ?? "party chat"}
        nicknames={room?.users.map((user) => user.name) ?? []}
        disabled={chat.status !== "connected" || !room || !roomName}
        onSend={(content) => {
          ipc.send({ kind: "Chat", command: { type: "sendMessage", payload: { channel: roomName, content } } });
        }}
      />
    </aside>
  );
}

function watchGame(game: Game): void {
  ipc.send({
    kind: "Replays",
    command: {
      type: "watchLive",
      payload: { uid: game.id, modName: game.modName, map: game.map },
    },
  });
}
