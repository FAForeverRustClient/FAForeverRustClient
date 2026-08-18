// The tournament's own chat: a global room, and one per match.
//
// Separate from the IRC chat tab on purpose, and not a copy of it: this is the
// server's own store, it is where an organiser answers questions during an
// event, and it is what a player checks when their opponent has not turned up.
//
// Which rooms exist is decided server-side by permission, so nothing is
// filtered here: a room this account may not see simply never arrives.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { ChatPost, ChatRoom, Tourney, TourneyLoadStatus } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";
import {
  chatGroups,
  completedWantsAttention,
  mayPostChat,
  roomBadge,
} from "../../shared/tourneyRules";

/**
 * How often the open room is re-read.
 *
 * The service has no push of any kind, so this is the only way a message from
 * somebody else ever arrives. Five seconds is what the website settled on: fast
 * enough that a conversation feels like one, slow enough that a room left open
 * on a second monitor is not a request per second.
 */
const POLL_MS = 5_000;

interface ChatPanelProps {
  event: Tourney;
  rooms: ChatRoom[];
  openRoomId: string | null;
  posts: ChatPost[];
  status: TourneyLoadStatus;
  busy: boolean;
  onOpenRoom: (roomId: string) => void;
  onPost: (body: string) => void;
  onDeletePost: (roomId: string, postId: string) => void;
  onMute: (fafId: number, name: string, muted: boolean) => void;
  onRefresh: (roomId: string) => void;
}

export function ChatPanel({
  event,
  rooms,
  openRoomId,
  posts,
  status,
  busy,
  onOpenRoom,
  onPost,
  onDeletePost,
  onMute,
  onRefresh,
}: ChatPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  /** Finished matches start folded away, which is the whole point of the group. */
  const [showCompleted, setShowCompleted] = useState(false);

  // Poll while a room is open, and stop the moment it is not: the interval is
  // torn down when the section closes or the reader switches events, so a tab
  // left on the bracket costs nothing.
  useEffect(() => {
    if (openRoomId === null) return;
    const timer = window.setInterval(() => onRefresh(openRoomId), POLL_MS);
    return () => window.clearInterval(timer);
  }, [openRoomId, onRefresh]);

  if (rooms.length === 0) {
    return <p className="muted">{t("tournaments.chat.none")}</p>;
  }

  const { active, completed } = chatGroups(rooms);

  const send = () => {
    const body = draft.trim();
    if (body === "" || openRoomId === null) return;
    onPost(body);
    setDraft("");
  };

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
        onClick={() => onOpenRoom(room.id)}
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

  return (
    <div className="tournament-chat">
      <ul className="tournament-chat-rooms">
        {active.map((room) => (
          <li key={room.id}>{roomButton(room)}</li>
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

      <div className="tournament-chat-room-body">
        {openRoomId === null ? (
          <p className="muted">{t("tournaments.chat.pickRoom")}</p>
        ) : (
          <>
            {status.type === "loading" && posts.length === 0 && (
              <p className="muted">{t("tournaments.chat.loading")}</p>
            )}
            {status.type === "failed" && (
              <p className="surface-error">{status.payload.reason}</p>
            )}
            {status.type === "ready" && posts.length === 0 && (
              <p className="muted">{t("tournaments.chat.empty")}</p>
            )}

            <ol className="tournament-chat-posts">
              {posts.map((post) => (
                <li
                  className={post.system ? "tournament-chat-post is-system" : "tournament-chat-post"}
                  key={post.id}
                >
                  {/* A system line is the server speaking: a dice roll nobody
                      could have faked, or an organiser ping. It reads as an
                      announcement rather than as something somebody typed. */}
                  {!post.system && <span className="tournament-chat-author">{post.author}</span>}
                  <span className="tournament-chat-body">{post.body}</span>
                  {/* Moderation sits on the post rather than in a list of its
                      own, because that is where the organiser is when they
                      decide: they are reading the thing they object to. A
                      system line has no author to silence. */}
                  {event.viewer.organiser && openRoomId !== null && (
                    <span className="tournament-chat-moderate">
                      <button
                        type="button"
                        className="tournament-chat-action"
                        disabled={busy}
                        onClick={() => onDeletePost(openRoomId, post.id)}
                      >
                        {t("tournaments.chat.deletePost")}
                      </button>
                      {post.fafId !== null && !post.system && (
                        <button
                          type="button"
                          className="tournament-chat-action"
                          disabled={busy}
                          onClick={() => onMute(post.fafId as number, post.author, true)}
                        >
                          {t("tournaments.chat.mute")}
                        </button>
                      )}
                    </span>
                  )}
                  {post.at !== null && (
                    <time className="muted" dateTime={new Date(post.at * 1000).toISOString()}>
                      {new Date(post.at * 1000).toLocaleTimeString("en-US", {
                        timeStyle: "short",
                      })}
                    </time>
                  )}
                </li>
              ))}
            </ol>

            {event.chatLocked ? (
              // Reading an old event's chat stays possible; the server closes
              // posting two days after it ends.
              <p className="muted">{t("tournaments.chat.locked")}</p>
            ) : event.chatMutedMe ? (
              // Told before typing rather than after. The service refuses a
              // muted account's post with a sentence they only see once they
              // have written one.
              <p className="muted">{t("tournaments.chat.muted")}</p>
            ) : (
              <form
                className="tournament-chat-composer"
                onSubmit={(submitted) => {
                  submitted.preventDefault();
                  send();
                }}
              >
                <input
                  value={draft}
                  onChange={(changed) => setDraft(changed.target.value)}
                  placeholder={t("tournaments.chat.placeholder")}
                  aria-label={t("tournaments.chat.placeholder")}
                  title={t("tournaments.chat.commands")}
                />
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || draft.trim() === "" || !mayPostChat(event)}
                >
                  <Icon name="arrowRight" size={14} /> {t("tournaments.chat.send")}
                </Button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
