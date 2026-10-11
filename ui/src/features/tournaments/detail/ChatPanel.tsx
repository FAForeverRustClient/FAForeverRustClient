// The tournament's own chat: a global room, and one per match.
//
// Separate from the IRC chat tab on purpose, and not a copy of it: this is the
// server's own store, it is where an organiser answers questions during an
// event, and it is what a player checks when their opponent has not turned up.
//
// Which rooms exist is decided server-side by permission, so nothing is
// filtered here: a room this account may not see simply never arrives.

import { memo, useState } from "react";
import { Icon } from "../../../design-system/Icon";
import type { ChatPost, ChatRoom, Tourney, TourneyLoadStatus } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { chatGroups, completedWantsAttention, roomBadge } from "../../../shared/rules/tourneyRules";
import { ChatRoomView } from "./ChatRoomView";
import { PinButton } from "./PinnedChat";
import type { ChatActions } from "../tourneyActions";

interface ChatPanelProps {
  event: Tourney;
  rooms: ChatRoom[];
  openRoomId: string | null;
  posts: ChatPost[];
  status: TourneyLoadStatus;
  busy: boolean;
  /** Opening, reading and writing the rooms, and pinning one or letting it go. */
  chat: ChatActions;
  /** The room kept open beside the sections. */
  pinnedRoomId: string | null;
}

/**
 * Memoised: a pinned room's poll redraws the pane beside this tab every few
 * seconds, and nothing this tab shows comes from that room's posts.
 */
export const ChatPanel = memo(function ChatPanel({
  event,
  rooms,
  openRoomId,
  posts,
  status,
  busy,
  chat,
  pinnedRoomId,
}: ChatPanelProps) {
  const { t } = useTranslation();
  /** Finished matches start folded away, which is the whole point of the group. */
  const [showCompleted, setShowCompleted] = useState(false);

  if (rooms.length === 0) {
    return <p className="muted">{t("tournaments.chat.none")}</p>;
  }

  const { active, completed } = chatGroups(rooms);

  const roomButton = (room: ChatRoom) => {
    const badge = roomBadge(room);
    return (
      <button
        type="button"
        className={
          room.id === openRoomId
            ? "surface surface-interactive tournament-chat-room is-active"
            : "surface surface-interactive tournament-chat-room"
        }
        aria-current={room.id === openRoomId}
        onClick={() => chat.openRoom(room.id)}
      >
        <span>{room.name}</span>
        {/* One mark at a time: being named by `@` says more than a count, and
            replacing the count with it is what makes it findable. */}
        {badge === "mentioned" && (
          <span className="tournament-badge is-mention" title={t("tournaments.chat.mentioned")}>
            @
          </span>
        )}
        {badge === "unread" && (
          <span className="tournament-badge">{room.unread > 9 ? "9+" : room.unread}</span>
        )}
        {/* The organiser's own mark, drawn alongside rather than instead:
            somebody typed `!organizer` here and no organiser has read it. */}
        {room.needsOrganiser && event.viewer.organiser && (
          <span className="tournament-chat-bell" title={t("tournaments.chat.needsOrganiser")}>
            <Icon name="bell" size={14} />
          </span>
        )}
      </button>
    );
  };

  const organisers = event.organisers;
  return (
    <>
      {/* Before the event starts the organisers may not be watching, and the
          website says so, with where to reach them instead. */}
      {event.status === "signup" && (
        <div className="surface tournament-chat-prestart">
          <strong>{t("tournaments.chat.prestartTitle")}</strong>
          <p className="muted">
            {t("tournaments.chat.prestartBody")}
            {event.organiserDiscords.length > 0 &&
              ` ${t("tournaments.chat.prestartDiscord", { handles: event.organiserDiscords.join(", ") })}`}
          </p>
        </div>
      )}
      <div className="tournament-chat">
        <div className="tournament-chat-side">
          <ul className="tournament-chat-rooms">
            {active.map((room) => (
              <li key={room.id} className="tournament-chat-room-row">
                {roomButton(room)}
                <PinButton roomId={room.id} pinnedRoomId={pinnedRoomId} onPin={chat.pin} />
              </li>
            ))}

            {/* Finished matches, folded. A bracket produces a room per match and
                keeps them forever; leaving the played ones in the live list is what
                made this confusing to begin with. Collapsed by default, and it says
                so when a folded room has your name in it. */}
            {completed.length > 0 && (
              <li>
                <button
                  type="button"
                  className="surface surface-interactive tournament-chat-group"
                  aria-expanded={showCompleted}
                  onClick={() => setShowCompleted((open) => !open)}
                >
                  <Icon name={showCompleted ? "chevronDown" : "chevronRight"} size={14} />
                  <span>
                    {t("tournaments.chat.completed", { count: String(completed.length) })}
                  </span>
                  {!showCompleted && completedWantsAttention(rooms) && (
                    <span className="tournament-badge is-mention">!</span>
                  )}
                </button>
                {showCompleted && (
                  <ul className="tournament-chat-rooms tournament-chat-completed">
                    {completed.map((room) => (
                      <li key={room.id}>{roomButton(room)}</li>
                    ))}
                  </ul>
                )}
              </li>
            )}
          </ul>
          <small className="muted">{t("tournaments.chat.pinListHint")}</small>

          {organisers.length > 0 && (
            <div className="tournament-chat-organisers">
              <strong>{t("tournaments.chat.organisersTitle")}</strong>
              <ul>
                {organisers.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
              <small className="muted">{t("tournaments.chat.organisersHint")}</small>
            </div>
          )}
        </div>

        {openRoomId === null ? (
          <p className="muted">{t("tournaments.chat.pickRoom")}</p>
        ) : (
          <div className="tournament-chat-open">
          {rooms.some((room) => room.id === openRoomId && !room.done) && (
            <div className="tournament-chat-open-head">
              <PinButton roomId={openRoomId} pinnedRoomId={pinnedRoomId} onPin={chat.pin} full />
            </div>
          )}
          <ChatRoomView
            event={event}
            roomId={openRoomId}
            posts={posts}
            status={status}
            busy={busy}
            onPost={chat.post}
            chat={chat}
          />
          </div>
        )}
      </div>
    </>
  );
});
