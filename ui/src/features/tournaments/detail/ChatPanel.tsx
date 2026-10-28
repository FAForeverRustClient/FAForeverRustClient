// The tournament's own chat: a global room, and one per match.
//
// Separate from the IRC chat tab on purpose, and not a copy of it: this is the
// server's own store, it is where an organiser answers questions during an
// event, and it is what a player checks when their opponent has not turned up.
//
// Laid out as the Chat tab is (#654): the rooms as a strip of tabs across the
// top, with the Chat tab's unread counts and mention mark, a head row naming
// the open room with its pin, the conversation under it, and the organisers
// in a column on the right where the Chat tab keeps its roster. The room list
// down the left it replaced was a second, different way of reading a chat.
//
// Which rooms exist is decided server-side by permission, so nothing is
// filtered here: a room this account may not see simply never arrives.

import { memo, useState } from "react";
import { Icon } from "../../../design-system/Icon";
import { SectionTabs, sectionPanelProps, type SectionTab } from "../../../design-system/SectionTabs";
import type { ChatPost, ChatRoom, Tourney, TourneyLoadStatus } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { chatGroups, completedWantsAttention, roomBadge } from "../../../shared/rules/tourneyRules";
import { ChatRoomView } from "./ChatRoomView";
import { PinButton } from "./PinnedChat";
import type { ChatActions } from "../tourneyActions";

/** Ties each room's tab to the conversation it shows. */
const ROOM_TABS_ID = "tournament-chat-room";

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
  // A finished match's room stays a tab while it is the one being read, even
  // with the group folded, so opening it from elsewhere never shows a room
  // with no tab above it.
  const shown = showCompleted
    ? [...active, ...completed]
    : [...active, ...completed.filter((room) => room.id === openRoomId)];
  const openRoom = rooms.find((room) => room.id === openRoomId);

  const tabs: SectionTab<string>[] = shown.map((room) => {
    const badge = roomBadge(room);
    return {
      id: room.id,
      title: room.name,
      count: badge === "unread" ? room.unread : undefined,
      label: (
        <>
          <Icon name="chat" size={15} />
          <span className="tournament-chat-tab-name">{room.name}</span>
          {/* One mark at a time: being named by `@` says more than a count,
              and replacing the count with it is what makes it findable. */}
          {badge === "mentioned" && (
            <span className="section-tab-count is-mention" title={t("tournaments.chat.mentioned")}>
              @
            </span>
          )}
          {/* The organiser's own mark, drawn alongside rather than instead:
              somebody typed `!organizer` here and no organiser has read it. */}
          {room.needsOrganiser && event.viewer.organiser && (
            <span className="tournament-chat-bell" title={t("tournaments.chat.needsOrganiser")}>
              <Icon name="bell" size={14} />
            </span>
          )}
        </>
      ),
    };
  });

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
        <section className="tournament-chat-main">
          <div className="tournament-chat-tabrow">
            <SectionTabs
              className="tournament-chat-tabs"
              ariaLabel={t("tournaments.chat.roomsAria")}
              active={openRoomId}
              items={tabs}
              onChange={(roomId) => chat.openRoom(roomId)}
              idPrefix={ROOM_TABS_ID}
            />
            {/* Finished matches, folded. A bracket produces a room per match
                and keeps them forever; leaving the played ones in the strip
                is what made this confusing to begin with. It says so when a
                folded room has your name in it. */}
            {completed.length > 0 && (
              <button
                type="button"
                className="tournament-chat-group"
                aria-expanded={showCompleted}
                onClick={() => setShowCompleted((open) => !open)}
              >
                <Icon name={showCompleted ? "chevronDown" : "chevronRight"} size={14} />
                <span>{t("tournaments.chat.completed", { count: String(completed.length) })}</span>
                {!showCompleted && completedWantsAttention(rooms) && (
                  <span className="section-tab-count is-mention">!</span>
                )}
              </button>
            )}
          </div>

          {openRoom === undefined ? (
            <p className="muted tournament-chat-pick">{t("tournaments.chat.pickRoom")}</p>
          ) : (
            <div className="tournament-chat-panel" {...sectionPanelProps(ROOM_TABS_ID, openRoom.id)}>
              {/* The strip already names the room; the head carries what acts
                  on it, as the Chat tab's head row does. */}
              <header className="tournament-chat-head">
                <span className="tournament-chat-head-name" title={openRoom.name}>{openRoom.name}</span>
                <span className="spacer" />
                {!openRoom.done && (
                  <PinButton roomId={openRoom.id} pinnedRoomId={pinnedRoomId} onPin={chat.pin} full />
                )}
              </header>
              <ChatRoomView
                event={event}
                roomId={openRoom.id}
                posts={posts}
                status={status}
                busy={busy}
                onPost={chat.post}
                chat={chat}
              />
            </div>
          )}
        </section>

        {/* Where the Chat tab keeps its roster: who to ask, and how. */}
        <aside className="tournament-chat-roster surface-panel" aria-label={t("tournaments.chat.organisersTitle")}>
          <header className="tournament-chat-roster-head">
            <strong>{t("tournaments.chat.organisersTitle")}</strong>
            <span className="section-tab-count">{organisers.length}</span>
          </header>
          {organisers.length > 0 && (
            <ul className="tournament-chat-roster-list">
              {organisers.map((name) => (
                <li key={name}>
                  <Icon name="user" size={14} />
                  <span>{name}</span>
                </li>
              ))}
            </ul>
          )}
          <small className="muted">{t("tournaments.chat.organisersHint")}</small>
          <small className="muted">{t("tournaments.chat.pinListHint")}</small>
        </aside>
      </div>
    </>
  );
});
