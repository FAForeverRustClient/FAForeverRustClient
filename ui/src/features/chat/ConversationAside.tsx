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

import type { ChatChannel, Game, LobbyStatus, SocialState, VaultMap } from "../../ipc/bindings";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import { useTranslation } from "../../i18n/useTranslation";
import { ipc } from "../../ipc/client";
import { joinGame } from "../../shared/joinGame";
import { useNamedMapGeneration } from "../../shared/hooks/useNamedMapGeneration";
import { GameSummaryCard } from "./roster/GameSummaryCard";
import { gamePresenceForPlayer } from "./roster/gameSummary";
import type { RosterTier } from "./roster/RosterResizeHandle";
import { peerPresence } from "./peerPresence";

interface Props {
  /** The person on the other side; a private channel is named after them. */
  peer: string;
  /** The signed-in login, to tell the lobby's whole list from our own entry. */
  self: string;
  social: SocialState;
  lobbyStatus: LobbyStatus;
  /** Our channels, whose rosters say who is on chat right now. */
  channels: ChatChannel[];
  openGames: Game[];
  liveGames: Game[];
  mapVault: VaultMap[];
  /** Seconds since the epoch, ticked by the view so the game time advances. */
  now: number;
  /** Open a private conversation with somebody in the lineup. */
  onOpenConversation: (nickname: string) => void;
  /** Their player menu, the same one the roster and the messages open. */
  onPlayerContextMenu: (nickname: string, event: React.MouseEvent) => void;
  /**
   * How much room the lineup has, from the width the panel was dragged to.
   *
   * Stamped on the panel rather than read from it: the stylesheet needs the
   * answer before it lays anything out, and a container query would make the
   * three steps a property of whichever element happened to be the container.
   */
  tier: RosterTier;
}

export function ConversationAside({
  peer,
  self,
  social,
  lobbyStatus,
  channels,
  openGames,
  liveGames,
  mapVault,
  now,
  onOpenConversation,
  onPlayerContextMenu,
  tier,
}: Props) {
  const { t } = useTranslation();
  const presence = gamePresenceForPlayer(openGames, liveGames, peer, now);
  const mapGen = useNamedMapGeneration(presence?.game.map);

  if (!presence) {
    // Whether they are connected at all, which is what the panel could not
    // say (#479). Somebody in a game plainly is, so this is only asked when
    // they are not; and somebody offline is not in a game either, so the
    // line that says so is left out rather than said twice.
    const online = peerPresence(peer, self, social, lobbyStatus, channels);
    return (
      <aside
        className="chat-conversation-aside"
        data-tier={tier}
        aria-label={t("chat.aside.title", { name: peer })}
      >
        {online !== "unknown" && (
          <p className="chat-conversation-aside-empty muted" data-presence={online}>
            <Icon name="user" size={16} />{" "}
            {online === "online"
              ? t("chat.aside.online", { name: peer })
              : t("chat.aside.offline", { name: peer })}
          </p>
        )}
        {online !== "offline" && (
          <p className="chat-conversation-aside-empty muted">
            <Icon name="users" size={16} /> {t("chat.aside.notInGame", { name: peer })}
          </p>
        )}
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
    <aside
      className="chat-conversation-aside"
      data-tier={tier}
      aria-label={t("chat.aside.title", { name: peer })}
    >
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
        <div className="chat-aside-actions">
          {/* The way in as the replay tab's cards offer it: the client's
              primary button (#448). Generating a missing map stays a quiet
              one beside it. */}
          {(mapGen.canGenerate || mapGen.isGenerating) && (
            <Button
              className="chat-aside-action"
              disabled={mapGen.isGenerating}
              onClick={mapGen.generate}
            >
              <Icon
                name={mapGen.isGenerating ? "refresh" : "plus"}
                size={14}
                className={mapGen.isGenerating ? "spin" : undefined}
              />
              {mapGen.generateLabel}
            </Button>
          )}
          <Button variant="primary" className="chat-aside-action chat-aside-primary" onClick={act}>
            <Icon name="play" size={15} />
            {watching ? t("chat.aside.watch") : t("chat.aside.join")}
          </Button>
        </div>
      </div>
    </aside>
  );
}
