// The tournament's own chat: a global room, and one per match.
//
// Separate from the IRC chat tab on purpose, and not a copy of it: this is the
// server's own store, it is where an organiser answers questions during an
// event, and it is what a player checks when their opponent has not turned up.
//
// Laid out as the Chat tab is (#654): the rooms as a strip of tabs across the
// top, with the Chat tab's unread counts and mention mark, a head row saying
// who reads the open room with its pin, the conversation under it, and the
// organisers in a column on the right drawn as the Chat tab draws its roster.
// The room list down the left it replaced was a second, different way of
// reading a chat.
//
// Which rooms exist is decided server-side by permission, so nothing is
// filtered here: a room this account may not see simply never arrives.

import { memo, useState } from "react";
import { Button } from "../../../design-system/Button";
import { Icon } from "../../../design-system/Icon";
import { SectionTabs, sectionPanelProps, type SectionTab } from "../../../design-system/SectionTabs";
import type { ChatPost, ChatRoom, PlayerProfile, Tourney, TourneyLoadStatus } from "../../../ipc/bindings";
import { useTranslation } from "../../../i18n/useTranslation";
import { chatGroups, completedWantsAttention, roomBadge } from "../../../shared/rules/tourneyRules";
import { flagSrc } from "../../../shared/countryFlags";
import { usePlayerStyle } from "../../../shared/components/nameColors";
import { useCountryLabel } from "../../../shared/hooks/useCountryLabel";
import { openPlayerCard } from "../../../shared/playerCardActions";
import { playersByNickname } from "../../../store/reducer";
import { useAppStore } from "../../../store/store";
import type { MessageKey } from "../../../i18n";
import { ChatRoomView } from "./ChatRoomView";
import { PinButton } from "./PinnedChat";
import type { ChatActions } from "../tourneyActions";

/** Ties each room's tab to the conversation it shows. */
const ROOM_TABS_ID = "tournament-chat-room";

/**
 * Who reads a room, for the head row: the one thing about it the tab above
 * cannot say, where the Chat tab puts a channel's topic. The service names the
 * global room `global` and a match's `match:<id>`; anything else it might add
 * gets no claim made about it.
 */
function roomAudience(room: ChatRoom): MessageKey | null {
  if (room.id === "global") return "tournaments.chat.audienceGlobal";
  if (room.id.startsWith("match:")) return "tournaments.chat.matchChatHint";
  return null;
}

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
  const [searchRequest, setSearchRequest] = useState(0);

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
  const audience = openRoom === undefined ? null : roomAudience(openRoom);

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

  return (
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
              <span>{t("tournaments.chat.completed", { count: completed.length })}</span>
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
            {/* The strip already names the room, so this row carries what it
                does not, as the Chat tab's head row does: who reads it, where
                that row has the topic, and what acts on it. */}
            <header className="tournament-chat-head">
              {audience !== null && <p className="tournament-chat-topic">{t(audience)}</p>}
              <span className="spacer" />
              {/* The Chat tab's own button, opening the log's find bar. */}
              <Button
                className="chat-search-button"
                title={t("chat.search.shortcut")}
                onClick={() => setSearchRequest((request) => request + 1)}
              >
                <Icon name="search" size={14} /> {t("chat.search.open")}
              </Button>
              {!openRoom.done && (
                <PinButton roomId={openRoom.id} pinnedRoomId={pinnedRoomId} onPin={chat.pin} full />
              )}
            </header>
            <ChatRoomView
              event={event}
              roomId={openRoom.id}
              roomName={openRoom.name}
              posts={posts}
              status={status}
              busy={busy}
              onPost={chat.post}
              chat={chat}
              searchRequest={searchRequest}
            />
          </div>
        )}
      </section>

      <OrganiserRoster event={event} />
    </div>
  );
});

/**
 * The organisers, where the Chat tab keeps its roster and drawn as it draws
 * one: a group heading with its count, then a row per name with the avatar,
 * the flag and the name in the reader's colour for that player. Under them,
 * how to call them, and before the event starts, that they may not be
 * watching yet and where to reach them instead. That used to be a warning box
 * across the top of the whole tab, which pushed the conversation down for a
 * note about the people listed here.
 */
function OrganiserRoster({ event }: { event: Tourney }) {
  const { t } = useTranslation();
  const players = useAppStore((store) => store.state.social.players);
  const profiles = playersByNickname(players);
  const organisers = event.organisers;
  // The avatar box is held open on every row once anyone has an avatar, so
  // the flags and names stay in one column, as in the roster.
  const avatars = organisers.some((name) => profiles.get(name.toLowerCase())?.avatarUrl);
  return (
    <aside className="tournament-chat-roster surface-panel" aria-label={t("tournaments.chat.organisersTitle")}>
      <div className="tournament-chat-roster-list">
        <h3 className="tournament-chat-roster-heading">
          <span>{t("tournaments.chat.organisersTitle")}</span>
          <span className="tournament-chat-roster-count">{organisers.length}</span>
        </h3>
        {organisers.length > 0 && (
          <ul>
            {organisers.map((name) => (
              <OrganiserRow
                key={name}
                name={name}
                profile={profiles.get(name.toLowerCase())}
                avatars={avatars}
              />
            ))}
          </ul>
        )}
      </div>
      <footer className="tournament-chat-roster-notes">
        {event.status === "signup" && (
          <p>
            <strong>{t("tournaments.chat.prestartTitle")}</strong>{" "}
            {t("tournaments.chat.prestartBody")}
            {event.organiserDiscords.length > 0 &&
              ` ${t("tournaments.chat.prestartDiscord", { handles: event.organiserDiscords.join(", ") })}`}
          </p>
        )}
        <p>{t("tournaments.chat.organisersHint")}</p>
      </footer>
    </aside>
  );
}

function OrganiserRow({
  name,
  profile,
  avatars,
}: {
  name: string;
  profile: PlayerProfile | undefined;
  avatars: boolean;
}) {
  const { t } = useTranslation();
  const countryOf = useCountryLabel();
  const style = usePlayerStyle(name);
  return (
    <li>
      <button
        type="button"
        className="tournament-chat-roster-user"
        title={t("tournaments.entrants.openCard", { name })}
        onClick={() => openPlayerCard(profile?.id ?? null, name)}
      >
        {avatars && (
          <span className="tournament-chat-roster-avatar" aria-hidden="true">
            {profile?.avatarUrl ? (
              <img
                src={profile.avatarUrl}
                alt=""
                width={40}
                height={20}
                loading="lazy"
                decoding="async"
                draggable={false}
              />
            ) : null}
          </span>
        )}
        {profile?.country ? (
          <img
            className="tournament-chat-roster-flag"
            src={flagSrc(profile.country)}
            alt={countryOf(profile.country)}
            width={16}
            height={16}
            decoding="async"
            draggable={false}
          />
        ) : <span className="tournament-chat-roster-flag" aria-hidden="true" />}
        <span className="tournament-chat-roster-name" style={style}>{name}</span>
      </button>
    </li>
  );
}
