// One chat kept open beside the sections, the website's pinned chat.
//
// A captain waiting on an opponent, or an organiser answering one room while
// reading the bracket, should not have to keep switching to the Chat tab. So
// one room at a time can be pinned, and it stays beside whatever section is
// open, kept fresh the way the open room is. It is a second slot, so the Chat
// tab can show another room at the same time.

import type { ChatPost, ChatRoom, Tourney } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { ChatRoomView } from "./ChatRoomView";

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
  onPost: (body: string, replyTo: string | null) => void;
  onDeletePost: (roomId: string, postId: string) => void;
  onMute: (fafId: number, name: string, muted: boolean) => void;
  onRefresh: (roomId: string) => void;
  onOpenInTab: () => void;
  onUnpin: () => void;
}

export function PinnedChat(props: PinnedChatProps) {
  const { t } = useTranslation();
  return (
    <aside className="surface tournament-pinned-chat" aria-label={t("tournaments.chat.pinnedLabel")}>
      <header className="tournament-pinned-head">
        <span aria-hidden="true">{"\u{1F4CC}"}</span>
        <strong className="tournament-pinned-name">{props.room?.name ?? props.roomId}</strong>
        <button
          type="button"
          className="tournament-link-button"
          title={t("tournaments.chat.pinOpenInTab")}
          aria-label={t("tournaments.chat.pinOpenInTab")}
          onClick={props.onOpenInTab}
        >
          {"⤢"}
        </button>
        <button
          type="button"
          className="tournament-link-button"
          title={t("tournaments.chat.pinClose")}
          aria-label={t("tournaments.chat.pinClose")}
          onClick={props.onUnpin}
        >
          {"✕"}
        </button>
      </header>
      <ChatRoomView
        event={props.event}
        roomId={props.roomId}
        posts={props.posts}
        status={{ type: "ready" }}
        busy={props.busy}
        onPost={props.onPost}
        onDeletePost={props.onDeletePost}
        onMute={props.onMute}
        onRefresh={props.onRefresh}
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
  return (
    <button
      type="button"
      className={pinned ? "tournament-pin is-on" : "tournament-pin"}
      aria-pressed={pinned}
      title={t(pinned ? "tournaments.chat.unpin" : full ? "tournaments.chat.pinHint" : "tournaments.chat.pin")}
      onClick={() => onPin(pinned ? null : roomId)}
    >
      {"\u{1F4CC}"}
      {full && ` ${t(pinned ? "tournaments.chat.pinnedRight" : "tournaments.chat.pinRight")}`}
    </button>
  );
}
