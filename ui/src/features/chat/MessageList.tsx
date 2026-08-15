// The scrollback for one channel. Remounted per channel (the parent keys it on
// the channel name), so scroll position never leaks between conversations.
//
// Two behaviours come from the reference clients because they're what make a
// busy channel readable:
//
//  * Timestamps print only when the minute changes (Python client), so a fast
//    conversation isn't a column of identical numbers.
//  * The pane sticks to the bottom only while the user is already at the
//    bottom. Reading history is not interrupted by new traffic; a "jump to
//    latest" affordance appears instead.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatPreferences, ChatUser, PlayerProfile, Reaction, SocialState } from "../../ipc/bindings";
import { MessageReactions } from "./MessageReactions";
import { Icon } from "../../design-system/Icon";
import { formatTime, renderBody, resolvedNickStyle, showsTime } from "./chatFormat";
import type { ChatGameLink } from "./chatFormat";
import { useTranslation } from "../../i18n/useTranslation";

/** Distance from the bottom, in px, still counted as "at the bottom". */
const STICK_THRESHOLD = 48;

interface Props {
  messages: ChatMessage[];
  self: string;
  emptyLabel: string;
  onNickClick: (nick: string) => void;
  onNickContextMenu: (nick: string, event: React.MouseEvent) => void;
  showTimestamps: boolean;
  use24HourTime: boolean;
  users: ChatUser[];
  social: SocialState;
  preferences: ChatPreferences;
  searchRequest?: number;
  onGameLink?: (link: ChatGameLink) => void;
  /**
   * Reactions per server message id, for the channel being rendered. Optional
   * because not every surface that reuses this list has them: party chat runs
   * over the lobby protocol, which carries no reactions at all.
   */
  reactions?: MessageReactionsMap;
  onReact?: (msgid: string, emoji: string) => void;
  onUnreact?: (msgid: string, emoji: string) => void;
  /** Start answering this message. Absent where replying is not offered. */
  onReply?: (message: ChatMessage) => void;
  /** Resolve a `msgid` to the message it names, for the quoted line. */
  findByMsgid?: (msgid: string) => ChatMessage | undefined;
}

/** `msgid -> reactions`, so a row looks its own up without scanning a list. */
export type MessageReactionsMap = Readonly<Record<string, readonly Reaction[]>>;

/** Shared empty list, so a message without reactions keeps a stable identity
 *  across renders and does not defeat `Line`'s memoization. */
const EMPTY_REACTIONS: readonly Reaction[] = [];
const EMPTY_REACTION_MAP: MessageReactionsMap = {};
const noReact = () => {};

export const MessageList = memo(function MessageList({
  messages,
  self,
  emptyLabel,
  onNickClick,
  onNickContextMenu,
  showTimestamps,
  use24HourTime,
  users,
  social,
  preferences,
  searchRequest = 0,
  onGameLink,
  reactions = EMPTY_REACTION_MAP,
  onReact = noReact,
  onUnreact = noReact,
  onReply,
  findByMsgid,
}: Props) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  // A ref, not state: the scroll effect must read the *current* value without
  // taking a dependency on it (re-running on pin changes would fight the user).
  const pinnedRef = useRef(true);
  const [missed, setMissed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeMatch, setActiveMatch] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  // Stable, so `Line`'s `memo` actually holds. This used to be an inline
  // `rowRef={(node) => …}`, a fresh function on every render, which gave all
  // ~500 rows a changed prop for every incoming message: the whole scrollback
  // re-rendered (and re-parsed its bodies) per message, which is what made
  // joining a busy channel stall.
  const registerRow = useCallback((id: string, node: HTMLDivElement | null) => {
    if (node) rowRefs.current.set(id, node);
    else rowRefs.current.delete(id);
  }, []);
  const usersByName = useMemo(
    () => new Map(users.map((user) => [user.name.toLocaleLowerCase(), user])),
    [users],
  );
  const profilesByName = useMemo(
    () => new Map(social.players.map((profile) => [profile.login.toLocaleLowerCase(), profile])),
    [social.players],
  );
  const matchingIds = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return [];
    return messages
      .filter((message) => `${message.sender}\n${message.content}`.toLocaleLowerCase().includes(query))
      .map((message) => message.id);
  }, [messages, search]);
  const normalizedMatch = matchingIds.length === 0 ? -1 : Math.min(activeMatch, matchingIds.length - 1);
  const activeMessageId = normalizedMatch >= 0 ? matchingIds[normalizedMatch] : null;

  useEffect(() => {
    const onFind = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "f") return;
      event.preventDefault();
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    };
    window.addEventListener("keydown", onFind);
    return () => window.removeEventListener("keydown", onFind);
  }, []);

  useEffect(() => {
    if (searchRequest === 0) return;
    setSearchOpen(true);
    requestAnimationFrame(() => searchInputRef.current?.focus());
  }, [searchRequest]);

  useLayoutEffect(() => {
    if (activeMessageId) rowRefs.current.get(activeMessageId)?.scrollIntoView({ block: "center" });
  }, [activeMessageId]);

  // Layout effect so the jump happens before paint: no visible flick.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
      setMissed(false);
    } else {
      setMissed(true);
    }
  }, [messages.length]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD;
    if (pinnedRef.current) setMissed(false);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    pinnedRef.current = true;
    setMissed(false);
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearch("");
    setActiveMatch(0);
  };

  const navigateSearch = (direction: -1 | 1) => {
    if (matchingIds.length === 0) return;
    setActiveMatch((current) => (current + direction + matchingIds.length) % matchingIds.length);
  };

  return (
    <div className="chat-scroll-wrap">
      {searchOpen && (
        <div className="chat-conversation-search surface-raised" role="search">
          <Icon name="search" size={15} />
          <input
            ref={searchInputRef}
            value={search}
            placeholder={t("chat.search.placeholder")}
            aria-label={t("chat.search.placeholder")}
            onChange={(event) => { setSearch(event.target.value); setActiveMatch(0); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); navigateSearch(event.shiftKey ? -1 : 1); }
              if (event.key === "Escape") closeSearch();
            }}
          />
          <span aria-live="polite">
            {search.trim() ? (matchingIds.length > 0 ? t("chat.search.counter", { current: normalizedMatch + 1, total: matchingIds.length }) : t("chat.search.noMatches")) : t("chat.search.shortcut")}
          </span>
          <button type="button" aria-label={t("chat.search.previous")} title={t("chat.search.previous")} disabled={matchingIds.length === 0} onClick={() => navigateSearch(-1)}>
            <Icon className="is-previous" name="arrowRight" size={14} />
          </button>
          <button type="button" aria-label={t("chat.search.next")} title={t("chat.search.next")} disabled={matchingIds.length === 0} onClick={() => navigateSearch(1)}>
            <Icon name="arrowRight" size={14} />
          </button>
          <button type="button" aria-label={t("chat.search.close")} title={t("chat.search.close")} onClick={closeSearch}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      <div className="chat-messages surface-panel" ref={scrollRef} onScroll={onScroll}>
        {messages.length === 0 ? (
          <p className="muted chat-empty">{emptyLabel}</p>
        ) : (
          messages.map((message, i) => (
            <Line
              key={message.id}
              message={message}
              self={self}
              withTime={
                showTimestamps
                && showsTime(message.timestamp, messages[i - 1]?.timestamp, use24HourTime)
              }
              use24HourTime={use24HourTime}
              user={usersByName.get(message.sender.toLocaleLowerCase())}
              profile={profilesByName.get(message.sender.toLocaleLowerCase())}
              social={social}
              preferences={preferences}
              search={searchOpen ? search : ""}
              activeSearchMatch={message.id === activeMessageId}
              registerRow={registerRow}
              onNickClick={onNickClick}
              onNickContextMenu={onNickContextMenu}
              onGameLink={onGameLink}
              reactions={reactions[message.msgid ?? ""] ?? EMPTY_REACTIONS}
              onReact={onReact}
              onUnreact={onUnreact}
              onReply={onReply}
              quoted={message.replyTo ? findByMsgid?.(message.replyTo) : undefined}
            />
          ))
        )}
      </div>

      {missed && (
        <button type="button" className="chat-jump" onClick={jumpToLatest}>
          {t("chat.jumpToLatest")}
        </button>
      )}
    </div>
  );
});

const Line = memo(function Line({
  message,
  self,
  withTime,
  onNickClick,
  onNickContextMenu,
  use24HourTime,
  user,
  profile,
  social,
  preferences,
  search,
  activeSearchMatch,
  registerRow,
  onGameLink,
  reactions,
  onReact,
  onUnreact,
  onReply,
  quoted,
}: {
  message: ChatMessage;
  self: string;
  withTime: boolean;
  reactions: readonly Reaction[];
  onReact: (msgid: string, emoji: string) => void;
  onUnreact: (msgid: string, emoji: string) => void;
  onReply?: (message: ChatMessage) => void;
  /** The message this one answers, when it is still in the scrollback. */
  quoted?: ChatMessage;
  onNickClick: (nick: string) => void;
  onNickContextMenu: (nick: string, event: React.MouseEvent) => void;
  use24HourTime: boolean;
  user: ChatUser | undefined;
  profile: PlayerProfile | undefined;
  social: SocialState;
  preferences: ChatPreferences;
  search: string;
  activeSearchMatch: boolean;
  registerRow: (id: string, node: HTMLDivElement | null) => void;
  onGameLink: ((link: ChatGameLink) => void) | undefined;
}) {
  // Bound to this row's id here rather than in the parent, so the parent can
  // pass one stable callback to every row.
  const rowRef = useCallback(
    (node: HTMLDivElement | null) => registerRow(message.id, node),
    [registerRow, message.id],
  );
  const { t } = useTranslation();
  const body = renderBody(message.content, self, search, onGameLink);
  const time = withTime ? formatTime(message.timestamp, use24HourTime) : "";
  const fromSelf = !!self && message.sender === self;
  const nameStyle = resolvedNickStyle(message.sender, user, social, preferences);

  const nick = (
    <button
      type="button"
      className={nameStyle ? "chat-nick" : "chat-nick is-monochrome"}
      style={nameStyle}
      title={`Message ${message.sender}`}
      onClick={() => onNickClick(message.sender)}
      onContextMenu={(e) => onNickContextMenu(message.sender, e)}
    >
      {message.sender}
    </button>
  );

  return (
    <div ref={rowRef} className={`chat-message is-${message.kind}${fromSelf ? " is-self" : ""}${activeSearchMatch ? " is-search-active" : ""}`}>
      {/* The answered line, quoted from the scrollback rather than copied into
          the reply: an answer to something scrolled out of the retained window
          shows nothing, which is honest, where a stored copy would keep
          claiming text the channel no longer has. */}
      {quoted ? (
        <p className="chat-quote">
          <span className="chat-quote-sender">{quoted.sender}</span>
          <span className="chat-quote-body">{quoted.content}</span>
        </p>
      ) : null}
      {/* Info and error lines are client commentary, not somebody talking, so
          they get no nickname column: the way the Python client renders its
          INFO type. Actions fold the nick into the sentence. */}
      {message.kind === "info" || message.kind === "error" ? (
        <span className="chat-message-body">
          {message.sender && <span className="chat-message-actor">{message.sender} </span>}
          {body}
        </span>
      ) : message.kind === "action" ? (
        <span className="chat-message-body">
          <span className="chat-action-star">*</span> {nick} {body}
        </span>
      ) : (
        <>
          <span className="chat-message-avatar">
            {profile?.avatarUrl && (
              <img
                src={profile.avatarUrl}
                alt=""
                title={profile.avatarTooltip}
                width={40}
                height={20}
                loading="lazy"
                decoding="async"
                draggable={false}
              />
            )}
          </span>
          {nick}
          <span className="chat-message-body">{body}</span>
        </>
      )}
      <span className="chat-message-time">{time}</span>
      {message.kind === "info" || message.kind === "error" ? null : (
        <MessageReactions
          msgid={message.msgid ?? ""}
          reactions={reactions}
          self={self}
          onReact={(emoji) => onReact(message.msgid ?? "", emoji)}
          onUnreact={(emoji) => onUnreact(message.msgid ?? "", emoji)}
        />
      )}
      {onReply && message.msgid && message.kind !== "info" && message.kind !== "error" ? (
        <button
          type="button"
          className="chat-reply-trigger"
          aria-label={t("chat.reply.start")}
          title={t("chat.reply.start")}
          onClick={() => onReply(message)}
        >
          <Icon name="arrowRight" size={13} />
        </button>
      ) : null}
    </div>
  );
});

