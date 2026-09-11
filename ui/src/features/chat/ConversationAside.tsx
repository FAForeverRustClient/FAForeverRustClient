// The side panel of a private conversation.
//
// A channel fills this column with its roster. A private conversation has no
// roster, so the column was reserved and then left blank, and the one thing a
// reader wants there is the one thing they had to go hunting for: what the
// person they are talking to is doing right now.
//
// It is the roster badge's popover, standing open. Hovering a badge is fine
// when you are scanning a channel; it is the wrong gesture when the answer is
// the context of the conversation you are already in, and it cannot be read at
// all while you are typing.

import type { Game, SocialState, VaultMap } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import { ipc } from "../../ipc/client";
import { joinGame } from "../lobby/joinGame";
import { GameSummaryCard } from "./GameSummaryCard";
import { gamePresenceForPlayer } from "./gameSummary";

interface Props {
  /** The person on the other side; a private channel is named after them. */
  peer: string;
  social: SocialState;
  openGames: Game[];
  liveGames: Game[];
  mapVault: VaultMap[];
  /** Seconds since the epoch, ticked by the view so the game time advances. */
  now: number;
  /** Open a private conversation with somebody in the lineup. */
  onOpenConversation: (nickname: string) => void;
  /** Their player menu, the same one the roster and the messages open. */
  onPlayerContextMenu: (nickname: string, event: React.MouseEvent) => void;
}

export function ConversationAside({
  peer,
  social,
  openGames,
  liveGames,
  mapVault,
  now,
  onOpenConversation,
  onPlayerContextMenu,
}: Props) {
  const { t } = useTranslation();
  const presence = gamePresenceForPlayer(openGames, liveGames, peer, now);

  if (!presence) {
    return (
      <aside className="chat-conversation-aside" aria-label={t("chat.aside.title", { name: peer })}>
        <p className="chat-conversation-aside-empty muted">
          <Icon name="users" size={16} /> {t("chat.aside.notInGame", { name: peer })}
        </p>
      </aside>
    );
  }

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

  return (
    <aside className="chat-conversation-aside" aria-label={t("chat.aside.title", { name: peer })}>
      <div className="chat-conversation-aside-card">
        <GameSummaryCard
          presence={presence}
          social={social}
          vault={mapVault}
          now={now}
          showMap
          onOpenConversation={onOpenConversation}
          onPlayerContextMenu={onPlayerContextMenu}
        />
        <button type="button" className="chat-head-action chat-aside-action" onClick={act}>
          <Icon name={watching ? "eye" : "play"} size={14} />
          {watching ? t("chat.aside.watch") : t("chat.aside.join")}
        </button>
      </div>
    </aside>
  );
}
