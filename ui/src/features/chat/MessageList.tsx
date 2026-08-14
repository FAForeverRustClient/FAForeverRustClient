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

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatMessage, ChatPreferences, ChatUser, PlayerProfile, SocialState } from "../../ipc/bindings";
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
}

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
              rowRef={(node) => {
                if (node) rowRefs.current.set(message.id, node);
                else rowRefs.current.delete(message.id);
              }}
              onNickClick={onNickClick}
              onNickContextMenu={onNickContextMenu}
              onGameLink={onGameLink}
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

function Line({
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
  rowRef,
  onGameLink,
}: {
  message: ChatMessage;
  self: string;
  withTime: boolean;
  onNickClick: (nick: string) => void;
  onNickContextMenu: (nick: string, event: React.MouseEvent) => void;
  use24HourTime: boolean;
  user: ChatUser | undefined;
  profile: PlayerProfile | undefined;
  social: SocialState;
  preferences: ChatPreferences;
  search: string;
  activeSearchMatch: boolean;
  rowRef: (node: HTMLDivElement | null) => void;
  onGameLink: ((link: ChatGameLink) => void) | undefined;
}) {
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
    </div>
  );
}
