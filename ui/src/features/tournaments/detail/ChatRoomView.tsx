// One chat room: its posts and the composer under them.
//
// Shared by the Chat tab and the match chat popup, which the website opens
// from the bracket, the Vetoes tab and a match's details. The service has no
// push of any kind, so the room is re-read while it is on screen.
//
// Each line reads as a line of the client's own Chat tab (issue 367): avatar,
// name and message on one row, the time at the right edge and only when the
// minute changes, a run from one person kept together under one name, names
// in the reader's own name colours, and the line's actions in a small toolbar
// that appears over the line on hover or focus. What the tournament service
// adds on top stays: a day divider wherever the date changes, replies quoted
// above the reply with a click that jumps back to the original, `@mentions`
// highlighted and completed as they are typed, organiser moderation on the
// line, and a button that pings the organisers without anyone having to
// remember `!organizer`.
//
// The Chat tab's message list itself is not reused: it is built around IRC
// messages, reactions and private conversations, none of which this service
// has, and it has no place for moderation. The row grammar is what is shared.

import { memo, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import type { ChatPost, Tourney, TourneyLoadStatus } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { mayPostChat } from "../../../shared/rules/tourneyRules";
import { formatDate, formatDateTime } from "../../../shared/format/dates";
import { usePlayerStyle } from "../../../shared/components/nameColors";
import { openPlayerCard } from "../../../shared/playerCardActions";
import { useAppStore } from "../../../store/store";
import { playersByNickname } from "../../../store/reducer";
import {
  applyMention,
  mentionCandidates,
  mentionQuery,
  mentionSpans,
  postClock,
  postContinues,
  postShowsTime,
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

/** How close to the bottom still counts as reading the newest post. */
const STICK_PX = 60;

export interface ChatRoomViewProps {
  event: Tourney;
  roomId: string;
  posts: ChatPost[];
  status: TourneyLoadStatus;
  busy: boolean;
  onPost: (body: string, replyTo: string | null) => void;
  onDeletePost: (roomId: string, postId: string) => void;
  onMute: (fafId: number, name: string, muted: boolean) => void;
  onRefresh: (roomId: string) => void;
  /** A shorter log, for the popup. */
  compact?: boolean;
}

interface Reply {
  id: string;
  author: string;
  body: string;
}

export function ChatRoomView(props: ChatRoomViewProps) {
  const { event, roomId, posts, status, busy, onRefresh } = props;
  const { t } = useTranslation();
  // The Chat tab's own reading settings, so a line looks the same in both.
  const showTimestamps = useAppStore((store) => store.state.settings.chat.showTimestamps);
  const use24HourTime = useAppStore((store) => store.state.settings.chat.use24HourTime);
  const players = useAppStore((store) => store.state.social.players);
  const [draft, setDraft] = useState("");
  const [reply, setReply] = useState<Reply | null>(null);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [choice, setChoice] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const log = useRef<HTMLOListElement>(null);
  /** Whether the reader was at the bottom before the posts last changed. */
  const atBottom = useRef(true);

  // Poll while the room is on screen, and stop the moment it is not.
  useEffect(() => {
    const timer = window.setInterval(() => onRefresh(roomId), POLL_MS);
    return () => window.clearInterval(timer);
  }, [roomId, onRefresh]);

  // A room switch starts fresh: no half-written reply to another room's post.
  useEffect(() => {
    setReply(null);
    setMention(null);
    atBottom.current = true;
  }, [roomId]);

  // Keep the newest post in view, but only for a reader who was already
  // looking at it: somebody scrolled up to read history keeps their place.
  useLayoutEffect(() => {
    const element = log.current;
    if (element !== null && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [posts, roomId]);

  const candidates = mention === null ? [] : mentionCandidates(event, mention.query);

  const send = (body: string, replyTo: string | null) => {
    const text = body.trim();
    if (text === "") return;
    props.onPost(text, replyTo);
    setDraft("");
    setReply(null);
    setMention(null);
    atBottom.current = true;
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
    if (pressed.key === "Escape") {
      if (mention !== null) setMention(null);
      else if (reply !== null) setReply(null);
    }
  };

  const jump = (postId: string) => {
    const target = log.current?.querySelector(`[data-post="${CSS.escape(postId)}"]`);
    if (target === null || target === undefined) {
      setNote(t("tournaments.chat.notLoaded"));
      window.setTimeout(() => setNote(null), 3000);
      return;
    }
    target.scrollIntoView({ block: "center" });
    setFlash(postId);
    window.setTimeout(() => setFlash((held) => (held === postId ? null : held)), 1200);
  };

  const organiser = event.viewer.organiser;
  const mayWrite = !event.chatLocked && !event.chatMutedMe;

  const profiles = playersByNickname(players);

  let lastDay = "";
  const rows = posts.flatMap((post, index) => {
    const out = [];
    // The post above this one, for grouping and the time column. A day
    // divider starts afresh: the first line under it names its author and
    // prints its time.
    let previous: ChatPost | undefined = posts[index - 1];
    if (post.at !== null) {
      const day = formatDate(post.at * 1000, "", { day: "numeric", month: "short", year: "numeric" });
      if (day !== lastDay) {
        out.push(
          <li className="tournament-chat-day" key={`day-${post.id}`} aria-hidden>
            <span>{day}</span>
          </li>,
        );
        lastDay = day;
        previous = undefined;
      }
    }
    const time = (
      <span className="tournament-chat-time">
        {post.at !== null && showTimestamps && postShowsTime(post, previous, use24HourTime) && (
          <time dateTime={new Date(post.at * 1000).toISOString()} title={formatDateTime(post.at * 1000, "")}>
            {postClock(post.at, use24HourTime)}
          </time>
        )}
      </span>
    );
    if (post.system) {
      // The server speaking: a dice roll nobody could have faked, or an
      // organiser ping. An announcement rather than something somebody typed,
      // so it has no name column, as the Chat tab draws its info lines.
      out.push(
        <li className="tournament-chat-post is-system" key={post.id} data-post={post.id}>
          <span className="tournament-chat-avatar" aria-hidden />
          <span className="tournament-chat-author" aria-hidden />
          <span className="tournament-chat-text">{post.body}</span>
          {time}
        </li>,
      );
      return out;
    }
    const continued = postContinues(post, previous);
    const avatar = continued ? undefined : profiles.get(post.author.toLowerCase());
    const classes = ["tournament-chat-post"];
    if (continued) classes.push("is-continued");
    if (post.everyone) classes.push("is-everyone");
    if (flash === post.id) classes.push("is-flash");
    const moderate = organiser;
    out.push(
      <li className={classes.join(" ")} key={post.id} data-post={post.id}>
        {post.replyTo !== null && (
          <button
            type="button"
            className="tournament-chat-quote"
            title={t("tournaments.chat.jumpHint")}
            onClick={() => post.replyTo !== null && jump(post.replyTo.id)}
          >
            <span className="tournament-chat-quote-who">{post.replyTo.author}</span>
            <span className="tournament-chat-quote-text">{post.replyTo.body}</span>
          </button>
        )}
        <span className="tournament-chat-avatar">
          {avatar?.avatarUrl && (
            <img
              src={avatar.avatarUrl}
              alt=""
              title={avatar.avatarTooltip || undefined}
              width={32}
              height={18}
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          )}
        </span>
        {continued ? (
          <span className="tournament-chat-author is-continued" aria-hidden />
        ) : (
          <PostAuthor name={post.author} fafId={post.fafId} />
        )}
        <span className="tournament-chat-text">
          {mentionSpans(post.body).map((span, part) =>
            span.kind === "mention" ? (
              <span className="tournament-chat-ping" key={part}>
                {span.text}
              </span>
            ) : (
              <span key={part}>{span.text}</span>
            ),
          )}
        </span>
        {time}
        {(mayWrite || moderate) && (
          // The Chat tab's floating toolbar: always in the tab order, shown
          // while the line is hovered or focus is inside it.
          <span
            className="tournament-chat-tools"
            role="group"
            aria-label={t("chat.message.actions", { name: post.author })}
          >
            {mayWrite && (
              <button
                type="button"
                className="tournament-chat-tool"
                aria-label={t("tournaments.chat.reply")}
                title={t("tournaments.chat.reply")}
                onClick={() => {
                  setReply({ id: post.id, author: post.author, body: post.body.slice(0, 140) });
                  input.current?.focus();
                }}
              >
                <Icon name="arrowRight" size={13} />
              </button>
            )}
            {/* Moderation sits on the post rather than in a list of its own,
                because that is where the organiser is when they decide. */}
            {moderate && (
              <button
                type="button"
                className="tournament-chat-tool is-danger"
                disabled={busy}
                aria-label={t("tournaments.chat.deletePost")}
                title={t("tournaments.chat.deletePost")}
                onClick={() => props.onDeletePost(roomId, post.id)}
              >
                <Icon name="trash" size={13} />
              </button>
            )}
            {moderate && post.fafId !== null && (
              <button
                type="button"
                className="tournament-chat-tool is-danger"
                disabled={busy}
                aria-label={t("tournaments.chat.mute")}
                title={t("tournaments.chat.mute")}
                onClick={() => props.onMute(post.fafId as number, post.author, true)}
              >
                <Icon name="userX" size={13} />
              </button>
            )}
          </span>
        )}
      </li>,
    );
    return out;
  });

  return (
    <div className={props.compact ? "tournament-chat-room-body is-compact" : "tournament-chat-room-body"}>
      {status.type === "failed" && <p className="surface-error">{status.payload.reason}</p>}
      <ol
        className="tournament-chat-posts surface-panel"
        ref={log}
        onScroll={(scrolled) => {
          const element = scrolled.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX;
        }}
      >
        {status.type === "loading" && posts.length === 0 && (
          <li className="muted">{t("tournaments.chat.loading")}</li>
        )}
        {status.type === "ready" && posts.length === 0 && (
          <li className="muted">{t("tournaments.chat.empty")}</li>
        )}
        {rows}
      </ol>

      {event.chatLocked ? (
        // Reading an old event's chat stays possible; the server closes
        // posting two days after it ends.
        <p className="muted">{t("tournaments.chat.locked")}</p>
      ) : event.chatMutedMe ? (
        // Told before typing rather than after.
        <p className="muted">{t("tournaments.chat.muted")}</p>
      ) : (
        <>
          {reply !== null && (
            <div className="tournament-chat-replybar">
              <span className="muted">{t("tournaments.chat.replyingTo")}</span>
              <strong>{reply.author}</strong>
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
          <form
            className="tournament-chat-composer"
            onSubmit={(submitted) => {
              submitted.preventDefault();
              send(draft, reply?.id ?? null);
            }}
          >
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
            <Button type="submit" variant="primary" disabled={busy || draft.trim() === "" || !mayPostChat(event)}>
              {t("tournaments.chat.send")}
            </Button>
            {/* Organisers are the ones being asked for; everybody else gets
                the button, and whatever they have typed goes with it. */}
            {!organiser && (
              <Button
                disabled={busy || !mayPostChat(event)}
                title={t("tournaments.chat.pingHint")}
                onClick={() => send(`!organizer ${draft}`.trim(), null)}
              >
                <Icon name="bell" size={14} /> {t("tournaments.chat.ping")}
              </Button>
            )}
          </form>
          {note !== null && <p className="muted tournament-chat-note">{note}</p>}
        </>
      )}
    </div>
  );
}

/**
 * A post's author in the name column, in the colour the reader gave that
 * player (friend, foe, a colour of their own, or the generated one), as the
 * Chat tab colours names. A click opens the FAF player card: there is no
 * private conversation to open from a tournament room, and the card is what
 * an organiser wants from a name.
 */
const PostAuthor = memo(function PostAuthor({ name, fafId }: { name: string; fafId: number | null }) {
  const { t } = useTranslation();
  const style = usePlayerStyle(name);
  return (
    <button
      type="button"
      className="tournament-chat-author"
      style={style}
      title={t("tournaments.entrants.openCard", { name })}
      onClick={() => openPlayerCard(fafId, name)}
    >
      {name}
    </button>
  );
});
