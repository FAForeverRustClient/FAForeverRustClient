// One chat kept open beside the sections, the website's pinned chat.
//
// A captain waiting on an opponent, or an organiser answering one room while
// reading the bracket, should not have to keep switching to the Chat tab. So
// one room at a time can be pinned, and it stays beside whatever section is
// open, kept fresh the way the open room is. It is a second slot, so the Chat
// tab can show another room at the same time.

import type { ChatPost, ChatRoom, Tourney } from "../../../ipc/bindings";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { useTranslation } from "../../../i18n/useTranslation";
import { ChatRoomView } from "./ChatRoomView";
import type { ChatActions } from "../tourneyActions";

/** Whether a room can be pinned: not a finished match's. */
export function pinnable(room: ChatRoom | undefined): boolean {
  return room !== undefined && !room.done;
}

interface PinnedChatProps {
  event: Tourney;
  roomId: string;
  room: ChatRoom | undefined;
  posts: ChatPost[];
  busy: boolean;
  /** Posting goes to this room by name: it is not always the open one. */
  chat: Pick<ChatActions, "postTo" | "deletePost" | "mute" | "refresh">;
  onOpenInTab: () => void;
  onUnpin: () => void;
}

export function PinnedChat(props: PinnedChatProps) {
  const { t } = useTranslation();
  return (
    <aside className="surface tournament-pinned-chat" aria-label={t("tournaments.chat.pinnedLabel")}>
      {/* Drawn icons, as everywhere else in the client: this head was a pin
          emoji and two typed arrows, the only glyphs of their kind left. */}
      <header className="tournament-pinned-head">
        <Icon name="panelRight" size={15} />
        <strong className="tournament-pinned-name">{props.room?.name ?? props.roomId}</strong>
        <button
          type="button"
          className="tournament-pinned-tool"
          title={t("tournaments.chat.pinOpenInTab")}
          aria-label={t("tournaments.chat.pinOpenInTab")}
          onClick={props.onOpenInTab}
        >
          <Icon name="chat" size={14} />
        </button>
        <button
          type="button"
          className="tournament-pinned-tool"
          title={t("tournaments.chat.pinClose")}
          aria-label={t("tournaments.chat.pinClose")}
          onClick={props.onUnpin}
        >
          <Icon name="close" size={14} />
        </button>
      </header>
      <ChatRoomView
        event={props.event}
        roomId={props.roomId}
        roomName={props.room?.name ?? props.roomId}
        posts={props.posts}
        status={{ type: "ready" }}
        busy={props.busy}
        onPost={(body, replyTo) => props.chat.postTo(props.roomId, body, replyTo)}
        chat={props.chat}
        compact
      />
    </aside>
  );
}

/** The pin switch shown beside a room and in a room's header. */
export function PinButton({
  roomId,
  pinnedRoomId,
  onPin,
  full = false,
}: {
  roomId: string;
  pinnedRoomId: string | null;
  onPin: (roomId: string | null) => void;
  /** The header's wording rather than the room list's bare pin. */
  full?: boolean;
}) {
  const { t } = useTranslation();
  const pinned = pinnedRoomId === roomId;
  // A button that looks like one, at the head row's height, as the Chat
  // tab's Search is. The icon is the panel the room goes to.
  return (
    <Button
      className={pinned ? "tournament-pin is-on" : "tournament-pin"}
      aria-pressed={pinned}
      aria-label={full ? undefined : t(pinned ? "tournaments.chat.unpin" : "tournaments.chat.pin")}
      title={t(pinned ? "tournaments.chat.unpin" : full ? "tournaments.chat.pinHint" : "tournaments.chat.pin")}
      onClick={() => onPin(pinned ? null : roomId)}
    >
      <Icon name="panelRight" size={14} />
      {full && t(pinned ? "tournaments.chat.pinnedRight" : "tournaments.chat.pinRight")}
    </Button>
  );
}
