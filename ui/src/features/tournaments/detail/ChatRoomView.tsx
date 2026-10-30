// One chat room: its posts and the composer under them.
//
// Shared by the Chat tab and the match chat popup, which the website opens
// from the bracket, the Vetoes tab and a match's details, and by the pinned
// panel. The service has no push of any kind, so the room is re-read while it
// is on screen.
//
// The log is the Chat tab's own (`MessageList`), fed the room's posts as chat
// lines, so a room reads exactly as a channel does: the same name colours,
// avatars, runs from one person, times, quotes, find bar, player menu on a
// right-click of a name and reply on a right-click of a line. It used to be a
// copy of that log's styles, and the copy drifted until the two no longer
// looked alike. What the service adds rides on the list's own hooks: an
// organiser's delete and silence in a line's toolbar, and a tint on an
// organiser's `@everyone`. The composer keeps what is the tournament's own:
// `@mentions` completed as they are typed, and a bell that pings the
// organisers without anyone having to remember `!organizer`.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { useOverlayLayer } from "../../../design-system/useOverlayLayer";
import { StatusNotice } from "../../../design-system/StatusNotice";
import type { ChatMessage, ChatPost, Tourney, TourneyLoadStatus } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { plainError } from "../../../shared/plainError";
import { mayPostChat } from "../../../shared/rules/tourneyRules";
import { openPlayerCard } from "../../../shared/playerCardActions";
import { usePlayerMenu } from "../../../shared/hooks/usePlayerMenu";
import { useAppStore } from "../../../store/store";
import { MessageList } from "../../chat/messages/MessageList";
import "../../chat/chat.css";
import type { ChatActions } from "../tourneyActions";
import {
  applyMention,
  mentionCandidates,
  mentionQuery,
  postMessage,
  quotedPosts,
  roomUsers,
  type MentionQuery,
} from "./chatPresentation";

/**
 * How often the open room is re-read.
 *
 * The service has no push of any kind, so this is the only way a message from
 * somebody else ever arrives. Five seconds: fast enough that a conversation
 * feels like one, slow enough that a room left open on a second monitor is not
 * a request per second.
 */
const POLL_MS = 5_000;

/** The website's limit, on both ends. */
const MAX_LENGTH = 500;

export interface ChatRoomViewProps {
  event: Tourney;
  roomId: string;
  /** Named in the composer's placeholder, as the Chat tab names the channel. */
  roomName: string;
  posts: ChatPost[];
  status: TourneyLoadStatus;
  busy: boolean;
  onPost: (body: string, replyTo: string | null) => void;
  /** Moderating a post, and re-reading the room while it is on screen. */
  chat: Pick<ChatActions, "deletePost" | "mute" | "refresh">;
  /** A shorter log, for the popup and the pinned panel. */
  compact?: boolean;
  /** Bumped by the head row's Search button to open the log's find bar. */
  searchRequest?: number;
}

interface Reply {
  id: string;
  author: string;
  body: string;
}

export function ChatRoomView(props: ChatRoomViewProps) {
  const { event, roomId, posts, status, busy } = props;
  const onRefresh = props.chat.refresh;
  const { deletePost, mute } = props.chat;
  const { t } = useTranslation();
  // The Chat tab's own reading settings and name colours, so a line looks
  // the same in both.
  const preferences = useAppStore((store) => store.state.settings.chat);
  const social = useAppStore((store) => store.state.social);
  const self = useAppStore((store) => store.state.auth.player?.name ?? "");
  const { openPlayerMenu, playerMenu, playerMenuTarget } = usePlayerMenu();
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState<Reply | null>(null);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [choice, setChoice] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  // Poll while the room is on screen, and stop the moment it is not.
  useEffect(() => {
    const timer = window.setInterval(() => onRefresh(roomId), POLL_MS);
    return () => window.clearInterval(timer);
  }, [roomId, onRefresh]);

  // A room switch starts fresh: no half-written reply to another room's post.
  useEffect(() => {
    setReply(null);
    setMention(null);
  }, [roomId]);

  const candidates = mention === null ? [] : mentionCandidates(event, mention.query);
  const mayWrite = !event.chatLocked && !event.chatMutedMe;
  useOverlayLayer(mayWrite && (mention !== null || reply !== null), () => {
    if (mention !== null) setMention(null);
    else setReply(null);
  });

  const send = (body: string, replyTo: string | null) => {
    const text = body.trim();
    if (text === "") return;
    props.onPost(text, replyTo);
    setDraft("");
    setReply(null);
    setMention(null);
  };

  const updateMention = (text: string, caret: number) => {
    const found = mentionQuery(text, caret);
    setMention(found);
    setChoice(0);
  };

  const complete = (name: string) => {
    const element = input.current;
    if (element === null || mention === null) return;
    const caret = element.selectionStart ?? draft.length;
    const next = applyMention(draft, caret, mention, name);
    setDraft(next.text.slice(0, MAX_LENGTH));
    setMention(null);
    window.requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  };

  const onKeyDown = (pressed: KeyboardEvent<HTMLInputElement>) => {
    if (pressed.nativeEvent.isComposing) return;
    if (mention !== null && candidates.length > 0) {
      if (pressed.key === "ArrowDown" || pressed.key === "ArrowUp") {
        pressed.preventDefault();
        const step = pressed.key === "ArrowDown" ? 1 : -1;
        setChoice((held) => (held + step + candidates.length) % candidates.length);
        return;
      }
      if (pressed.key === "Enter" || pressed.key === "Tab") {
        pressed.preventDefault();
        complete(candidates[choice] ?? candidates[0]);
        return;
      }
    }
  };

  const organiser = event.viewer.organiser;

  // The room as the log reads it. Every callback below is held stable, since
  // each line of the log is memoised on them.
  const messages = useMemo(() => posts.map(postMessage), [posts]);
  const quotes = useMemo(() => quotedPosts(posts), [posts]);
  const users = useMemo(() => roomUsers(event), [event]);
  const byId = useMemo(() => new Map(posts.map((post) => [post.id, post])), [posts]);
  const findByMsgid = useCallback((msgid: string) => quotes.get(msgid), [quotes]);
  const isAnnouncement = useCallback(
    (message: ChatMessage) => byId.get(message.id)?.everyone ?? false,
    [byId],
  );

  // A name opens the FAF player card: there is no private conversation to
  // open from a tournament room, and the card is what an organiser wants.
  const openCard = useCallback((nickname: string) => {
    const author = posts.find((post) => post.author.toLowerCase() === nickname.toLowerCase());
    void openPlayerCard(author?.fafId ?? null, nickname);
  }, [posts]);

  const startReply = useCallback((message: ChatMessage) => {
    setReply({ id: message.msgid ?? message.id, author: message.sender, body: message.content.slice(0, 140) });
    input.current?.focus();
  }, []);

  // Moderation sits on the post rather than in a list of its own, because
  // that is where the organiser is when they decide.
  const moderation = useCallback((message: ChatMessage) => {
    const post = byId.get(message.id);
    if (post === undefined) return null;
    return (
      <>
        <button
          type="button"
          className="chat-action-btn is-danger"
          disabled={busy}
          aria-label={t("tournaments.chat.deletePost")}
          title={t("tournaments.chat.deletePost")}
          onClick={() => deletePost(roomId, post.id)}
        >
          <Icon name="trash" size={13} />
        </button>
        {post.fafId !== null && (
          <button
            type="button"
            className="chat-action-btn is-danger"
            disabled={busy}
            aria-label={t("tournaments.chat.mute")}
            title={t("tournaments.chat.mute")}
            onClick={() => mute(post.fafId as number, post.author, true)}
          >
            <Icon name="userX" size={13} />
          </button>
        )}
      </>
    );
  }, [byId, busy, deletePost, mute, roomId, t]);

  return (
    <div className={props.compact ? "tournament-chat-room-body is-compact" : "tournament-chat-room-body"}>
      {/* Plainly, with the service's own words on hover. The room is read
          again every few seconds anyway; Retry is that read, now, for a
          reader who does not know it is coming. */}
      {status.type === "failed" && (
        <StatusNotice
          tone="error"
          action={{ label: t("common.retry"), onClick: () => onRefresh(roomId) }}
          detail={status.payload.reason}
        >
          {plainError(status.payload.reason)}
        </StatusNotice>
      )}
      <MessageList
        key={roomId}
        messages={messages}
        self={self}
        emptyLabel={t(status.type === "loading" ? "tournaments.chat.loading" : "tournaments.chat.empty")}
        onNickClick={openCard}
        onNickContextMenu={openPlayerMenu}
        menuTarget={playerMenuTarget}
        showTimestamps={preferences.showTimestamps}
        use24HourTime={preferences.use24HourTime}
        users={users}
        social={social}
        preferences={preferences}
        onReply={mayWrite ? startReply : undefined}
        findByMsgid={findByMsgid}
        conversationLabel={props.roomName}
        lineActions={organiser ? moderation : undefined}
        isAnnouncement={isAnnouncement}
        searchable={!props.compact}
        searchRequest={props.searchRequest}
      />

      {event.chatLocked ? (
        // Reading an old event's chat stays possible; the server closes
        // posting two days after it ends. Where the composer would be, so the
        // reason sits where the reader looks for the field.
        <p className="tournament-chat-closed">
          <Icon name="lock" size={14} />
          {t("tournaments.chat.locked")}
        </p>
      ) : event.chatMutedMe ? (
        // Told before typing rather than after.
        <p className="tournament-chat-closed">
          <Icon name="lock" size={14} />
          {t("tournaments.chat.muted")}
        </p>
      ) : (
        <>
          {/* The Chat tab's composer (`.chat-compose-shell`): the reply being
              written above the field, then the field, one quiet icon button
              where the Chat tab has its emoji, and Send. */}
          <form
            className="tournament-chat-compose-shell"
            onSubmit={(submitted) => {
              submitted.preventDefault();
              send(draft, reply?.id ?? null);
            }}
          >
            {reply !== null && (
              <div className="tournament-chat-replybar">
                <span>
                  {t("tournaments.chat.replyingTo")} <strong>{reply.author}</strong>
                </span>
                <span className="tournament-chat-replybar-text">{reply.body}</span>
                <button
                  type="button"
                  className="tournament-chat-action"
                  aria-label={t("tournaments.chat.cancelReply")}
                  onClick={() => setReply(null)}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            )}
            <div className="tournament-chat-compose">
              <div className="tournament-chat-inwrap">
                <input
                  ref={input}
                  value={draft}
                  maxLength={MAX_LENGTH}
                  autoComplete="off"
                  onChange={(changed) => {
                    setDraft(changed.target.value);
                    updateMention(changed.target.value, changed.target.selectionStart ?? changed.target.value.length);
                  }}
                  onClick={(clicked) =>
                    updateMention(draft, clicked.currentTarget.selectionStart ?? draft.length)
                  }
                  onKeyDown={onKeyDown}
                  onBlur={() => window.setTimeout(() => setMention(null), 120)}
                  placeholder={t(
                    organiser ? "tournaments.chat.placeholderOrganiser" : "tournaments.chat.placeholderPlayer",
                    { room: props.roomName },
                  )}
                  aria-label={t("tournaments.chat.placeholder")}
                  title={t("tournaments.chat.commands")}
                />
                {mention !== null && candidates.length > 0 && (
                  <ul className="tournament-chat-mentions" role="listbox">
                    {candidates.map((name, index) => (
                      <li
                        key={name}
                        role="option"
                        aria-selected={index === choice}
                        className={index === choice ? "is-on" : undefined}
                        onMouseDown={(pressed) => {
                          pressed.preventDefault();
                          complete(name);
                        }}
                      >
                        @{name}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {/* Organisers are the ones being asked for; everybody else gets
                  the bell, and whatever they have typed goes with it. Beside the
                  field, where the Chat tab has its emoji button: a labelled
                  button the size of Send made the row read as two forms. */}
              {!organiser && (
                <button
                  type="button"
                  className="tournament-chat-ping-button"
                  disabled={busy || !mayPostChat(event)}
                  aria-label={t("tournaments.chat.ping")}
                  title={`${t("tournaments.chat.ping")}. ${t("tournaments.chat.pingHint")}`}
                  onClick={() => send(`!organizer ${draft}`.trim(), null)}
                >
                  <Icon name="bell" size={16} />
                </button>
              )}
              <Button type="submit" variant="primary" disabled={busy || draft.trim() === "" || !mayPostChat(event)}>
                {t("tournaments.chat.send")}
              </Button>
            </div>
          </form>
        </>
      )}
      {playerMenu}
    </div>
  );
}
