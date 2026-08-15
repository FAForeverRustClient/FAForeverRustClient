// The channel roster.
//
// Takes the Java client's grouped, filterable user list (`ChatUserListController`
// + `ChatUserCategory`): users are bucketed into ordered categories with a
// count per header, and a search box narrows the list without losing the
// grouping. Takes the Python client's "N users (type to filter)" affordance for
// the search field's label, which says what the box does without a tooltip.
//
// Each row carries the same decorations both clients show: avatar, country
// flag and clan tag: all of which come from the lobby's player record rather
// than from IRC, so an IRC-only nickname simply renders bare.
//
// Double-click opens a private conversation; right-click opens the user menu.

import { memo, useCallback, useMemo, useState } from "react";
import type { ChatPreferences, ChatUser, Game, PlayerProfile, SocialState, VaultMap } from "../../ipc/bindings";
import { Icon } from "../../design-system/Icon";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/store";
import { isModerator } from "../../store/reducer";
import {
  USER_CATEGORY_LABELS,
  USER_CATEGORY_ORDER,
  displayName,
  resolvedNickStyle,
  type UserCategory,
} from "./chatFormat";
import { flagSrc } from "../../shared/countryFlags";
import { GameSummaryPopover } from "./GameSummaryPopover";
import { gamePresenceIndex, type GamePresence } from "./gameSummary";
import { rosterRatingSummary } from "./ratingSummary";

interface Props {
  users: ChatUser[];
  self: string;
  social: SocialState;
  openGames: Game[];
  liveGames: Game[];
  mapVault: VaultMap[];
  preferences: ChatPreferences;
  onOpenConversation: (nick: string) => void;
  onContextMenu: (nick: string, event: React.MouseEvent) => void;
}

export const UserList = memo(function UserList({
  users,
  self,
  social,
  openGames,
  liveGames,
  mapVault,
  preferences,
  onOpenConversation,
  onContextMenu,
}: Props) {
  const [filter, setFilter] = useState("");
  const presences = useMemo(
    () => gamePresenceIndex(openGames, liveGames),
    [liveGames, openGames],
  );

  // Collapsed categories are a persisted preference, not component state: this
  // list is remounted on every tab switch, so local state would forget the
  // choice constantly. The Java client persists it too.
  const hidden = useMemo(
    () => new Set(preferences.hiddenRosterCategories),
    [preferences.hiddenRosterCategories],
  );
  const toggleCategory = useCallback(
    (category: UserCategory) => {
      const current = useAppStore.getState().state.settings.chat;
      const next = current.hiddenRosterCategories.includes(category)
        ? current.hiddenRosterCategories.filter((entry) => entry !== category)
        : [...current.hiddenRosterCategories, category];
      ipc.send({
        kind: "Settings",
        command: { type: "setChat", payload: { preferences: { ...current, hiddenRosterCategories: next } } },
      });
    },
    [],
  );

  const profilesByLogin = useMemo(
    () => new Map(social.players.map((p) => [p.login.toLowerCase(), p])),
    [social.players],
  );
  const friendsSet = useMemo(
    () => new Set(social.friends.map((f) => f.toLowerCase())),
    [social.friends],
  );

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = needle
      ? users.filter((u) => u.name.toLowerCase().includes(needle))
      : users;
    // Without the lobby we can't tell an account from an IRC-only nickname;
    // see `categoryOf`.
    const socialKnown = social.players.length > 0;
    const buckets = new Map<UserCategory, ChatUser[]>(
      USER_CATEGORY_ORDER.map((c) => [c, [] as ChatUser[]]),
    );
    for (const user of matching) {
      const lower = user.name.toLowerCase();
      let category: UserCategory;
      if (self && user.name === self) {
        category = "self";
      } else if (isModerator(user)) {
        category = "moderators";
      } else if (friendsSet.has(lower)) {
        category = "friends";
      } else if (!socialKnown || profilesByLogin.has(lower)) {
        category = "players";
      } else {
        category = "ircOnly";
      }
      buckets.get(category)?.push(user);
    }
    return buckets;
  }, [users, self, social, friendsSet, profilesByLogin, filter]);

  return (
    <div className="chat-roster surface-panel" id="chat-roster">
      <div className="chat-roster-search">
        <label className="chat-roster-search-field">
          <Icon name="search" size={14} />
          <input
            type="search"
            value={filter}
            placeholder={`${users.length} ${users.length === 1 ? "user" : "users"} · type to filter…`}
            aria-label={`Filter users (${users.length} ${users.length === 1 ? "user" : "users"})`}
            onChange={(e) => setFilter(e.target.value)}
          />
        </label>
      </div>

      <div className="chat-roster-list">
        {USER_CATEGORY_ORDER.map((category) => {
          const bucket = groups.get(category) ?? [];
          if (bucket.length === 0) return null;
          // A filter is a search: honouring a collapsed section while one is
          // active would hide the very match the user is looking for.
          const collapsed = hidden.has(category) && filter.trim() === "";
          return (
            <section key={category} className="chat-roster-group">
              <h3>
                <button
                  type="button"
                  className="chat-roster-heading"
                  aria-expanded={!collapsed}
                  title={collapsed ? `Show ${USER_CATEGORY_LABELS[category]}` : `Hide ${USER_CATEGORY_LABELS[category]}`}
                  onClick={() => toggleCategory(category)}
                >
                  {/* One glyph, rotated: expanded points down, collapsed
                      points right. The Java header uses the same two states. */}
                  <Icon
                    name="chevronRight"
                    size={15}
                    className={collapsed ? "chat-roster-chevron" : "chat-roster-chevron is-open"}
                  />
                  <span className="chat-roster-heading-label">{USER_CATEGORY_LABELS[category]}</span>
                  <span className="chat-roster-count">{bucket.length}</span>
                </button>
              </h3>
              <ul hidden={collapsed}>
                {bucket.map((user) => (
                  <RosterRow
                    key={user.name}
                    user={user}
                    profile={profilesByLogin.get(user.name.toLowerCase())}
                    social={social}
                    presence={presences.get(user.name.toLocaleLowerCase()) ?? null}
                    mapVault={mapVault}
                    preferences={preferences}
                    onOpenConversation={onOpenConversation}
                    onContextMenu={onContextMenu}
                  />
                ))}
              </ul>
            </section>
          );
        })}
        {users.length > 0 && [...groups.values()].every((b) => b.length === 0) && (
          <p className="muted chat-empty">No user matches “{filter.trim()}”.</p>
        )}
      </div>
    </div>
  );
});

const RosterRow = memo(function RosterRow({
  user,
  profile,
  social,
  presence,
  mapVault,
  preferences,
  onOpenConversation,
  onContextMenu,
}: {
  user: ChatUser;
  profile: PlayerProfile | undefined;
  social: SocialState;
  presence: GamePresence | null;
  mapVault: VaultMap[];
  preferences: ChatPreferences;
  onOpenConversation: (nick: string) => void;
  onContextMenu: (nick: string, event: React.MouseEvent) => void;
}) {
  const nameStyle = resolvedNickStyle(user.name, user, social, preferences);
  return (
    <li>
      <div
        className="chat-roster-user"
        onContextMenu={(e) => onContextMenu(user.name, e)}
      >
        <button
          type="button"
          className="chat-roster-identity"
          title={rosterRatingSummary(displayName(user.name, profile), profile)}
          onDoubleClick={() => onOpenConversation(user.name)}
        >
          <span className="chat-avatar">
            {profile?.avatarUrl ? (
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
            ) : null}
          </span>
          {profile?.country ? (
            <img
              className="chat-flag"
              src={flagSrc(profile.country)}
              alt={profile.country.toUpperCase()}
              title={profile.country.toUpperCase()}
              width={16}
              height={16}
              decoding="async"
              draggable={false}
              onError={(e) => {
                e.currentTarget.style.visibility = "hidden";
              }}
            />
          ) : null}
          <span
            className={`chat-nick${nameStyle ? "" : " is-monochrome"}`}
            style={nameStyle}
          >
            {profile?.clan && <span className="chat-clan">[{profile.clan}]</span>}
            {user.name}
          </span>
        </button>
        {presence && <GameSummaryPopover presence={presence} social={social} vault={mapVault} />}
      </div>
    </li>
  );
});
