// The tournament's own chat: a global room, and one per match.
//
// Separate from the IRC chat tab on purpose, and not a copy of it: this is the
// server's own store, it is where an organiser answers questions during an
// event, and it is what a player checks when their opponent has not turned up.
//
// Which rooms exist is decided server-side by permission, so nothing is
// filtered here: a room this account may not see simply never arrives.

import { useState } from "react";
import { Button } from "../../design-system/Button";
import { Icon } from "../../design-system/Icon";
import type { ChatPost, ChatRoom, Tourney, TourneyLoadStatus } from "../../ipc/bindings";
import { useTranslation } from "../../i18n/useTranslation";

interface ChatPanelProps {
  event: Tourney;
  rooms: ChatRoom[];
  openRoomId: string | null;
  posts: ChatPost[];
  status: TourneyLoadStatus;
  busy: boolean;
  onOpenRoom: (roomId: string) => void;
  onPost: (body: string) => void;
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
}: ChatPanelProps) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");

  if (rooms.length === 0) {
    return <p className="muted">{t("tournaments.chat.none")}</p>;
  }

  const send = () => {
    const body = draft.trim();
    if (body === "" || openRoomId === null) return;
    onPost(body);
    setDraft("");
  };

  return (
    <div className="tournament-chat">
      <ul className="tournament-chat-rooms">
        {rooms.map((room) => (
          <li key={room.id}>
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
              {room.unread > 0 && <span className="tournament-badge">{room.unread}</span>}
            </button>
          </li>
        ))}
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
                />
                <Button
                  type="submit"
                  variant="primary"
                  disabled={busy || draft.trim() === ""}
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
