// Presentation helpers shared by the chat panes: nickname tinting, message
// body rendering (links + mention highlighting) and timestamp thinning.
//
// Everything here is pure: the components stay declarative and these stay
// unit-reasonable.

import type { CSSProperties, ReactNode } from "react";
import type { ChatPreferences, ChatUser, PlayerProfile, SocialState } from "../../ipc/bindings";
import { openHttpsUrl, validateHttpsUrl } from "../../shared/externalLinks";
import { findPlayer, isModerator } from "../../store/reducer";

import { assignedPlayerColor, nickHue, nickStyle, resolvePlayerStyle } from "../../shared/nameColors";
export { nickHue, nickStyle };

export function isAdmin(user: ChatUser | undefined): boolean {
  return !!user?.elevation && user.elevation.split("").some((prefix) => prefix === "~" || prefix === "&");
}

/**
 * Resolve the one nickname colour policy shared by the roster and messages.
 * More specific assignments win over broader categories; generated per-name
 * colours are only the final fallback when the global option is enabled.
 */
export function resolvedNickStyle(
  name: string,
  user: ChatUser | undefined,
  social: SocialState,
  preferences: ChatPreferences,
): CSSProperties | undefined {
  const assignedColor = assignedPlayerColor(preferences.nameColors.players, name);
  if (assignedColor) return { color: assignedColor };

  if (isAdmin(user) && preferences.nameColors.admins) {
    return { color: preferences.nameColors.admins };
  }
  if (user && isModerator(user) && preferences.nameColors.moderators) {
    return { color: preferences.nameColors.moderators };
  }

  return resolvePlayerStyle(name, social, preferences);
}

/**
 * Roster grouping, in the order the sidebar renders it. Follows the Java
 * client's `ChatUserCategory` shape; `ircOnly` is its `CHAT_ONLY`: a nickname
 * in the channel that doesn't belong to any FAF account (bots, webchat guests),
 * which both reference clients sink to the bottom of the list.
 */
export type UserCategory = "self" | "moderators" | "friends" | "players" | "ircOnly";

export const USER_CATEGORY_LABELS: Record<UserCategory, string> = {
  self: "You",
  moderators: "Moderators & admins",
  friends: "Friends",
  players: "Players",
  ircOnly: "IRC only",
};

export const USER_CATEGORY_ORDER: UserCategory[] = [
  "self",
  "moderators",
  "friends",
  "players",
  "ircOnly",
];

/**
 * Which bucket a roster entry belongs to.
 *
 * Channel elevation comes from IRC; friendship and "is a FAF account at all"
 * come from the lobby (`state.social`): chat alone cannot tell a player from a
 * bot. Until the lobby connects, `social.players` is empty and everyone would
 * land in `ircOnly`, so callers pass `socialKnown` to fall back to `players`
 * instead of mislabelling the whole channel.
 */
export function categoryOf(
  user: ChatUser,
  self: string,
  social: SocialState,
  socialKnown: boolean,
): UserCategory {
  if (self && user.name === self) return "self";
  if (isModerator(user)) return "moderators";
  if (social.friends.includes(user.name)) return "friends";
  if (!socialKnown) return "players";
  return findPlayer(social, user.name) ? "players" : "ircOnly";
}

/** `[clan]name`, the way both reference clients render a chatter's name. */
export function displayName(name: string, profile: PlayerProfile | undefined): string {
  return profile?.clan ? `[${profile.clan}]${name}` : name;
}

const URL_PATTERN = /((?:https|fafgame|faflive):\/\/[^\s<>"']+)/gi;

export interface ChatGameLink {
  kind: "openGame" | "liveReplay";
  uid: number;
  map: string;
  mod: string;
  player: string;
  mods: string[];
}

/**
 * Parse the custom link grammar emitted by the Python client's `GameUrl`.
 *
 * The loopback host is intentional: these URLs normally point at the local
 * replay proxy. A click never navigates there; callers resolve the UID against
 * current lobby state before dispatching an action.
 */
export function parseChatGameLink(value: string): ChatGameLink | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const kind = url.protocol === "fafgame:"
    ? "openGame"
    : url.protocol === "faflive:"
      ? "liveReplay"
      : null;
  if (!kind || url.hostname !== "127.0.0.1" || url.username || url.password) return null;
  if (!url.searchParams.has("map") || !url.searchParams.has("mod")) return null;

  let path: string[];
  try {
    path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    return null;
  }
  let uidText: string;
  let player: string;
  if (kind === "openGame") {
    if (path.length !== 1 || !url.searchParams.has("uid")) return null;
    uidText = url.searchParams.get("uid") ?? "";
    [player] = path;
  } else {
    if (path.length !== 2 || !path[1].endsWith(".SCFAreplay")) return null;
    [uidText] = path;
    player = path[1].slice(0, -".SCFAreplay".length);
  }
  if (!/^\d+$/.test(uidText) || !player) return null;
  const uid = Number(uidText);
  if (!Number.isSafeInteger(uid) || uid <= 0) return null;

  return {
    kind,
    uid,
    map: url.searchParams.get("map") ?? "",
    mod: url.searchParams.get("mod") ?? "",
    player,
    mods: (url.searchParams.get("mods") ?? "").split(";").filter(Boolean),
  };
}

/**
 * Render a message body: linkify URLs and highlight our own nickname.
 *
 * Splitting on the URL pattern first means a nickname inside a link's text is
 * never wrapped, which would break the href.
 */
export function renderBody(
  content: string,
  self: string,
  search = "",
  onGameLink?: (link: ChatGameLink) => void,
): ReactNode[] {
  return content.split(URL_PATTERN).map((part, i) => {
    if (i % 2 === 1) {
      const gameLink = parseChatGameLink(part);
      if (gameLink) {
        return onGameLink ? (
          <button
            key={i}
            type="button"
            className="chat-link chat-game-link"
            title={gameLink.kind === "openGame" ? "Join game" : "Watch live replay"}
            onClick={() => onGameLink(gameLink)}
          >
            {part}
          </button>
        ) : <span key={i}>{part}</span>;
      }
      let href: string;
      try {
        href = validateHttpsUrl(part);
      } catch {
        return <span key={i}>{part}</span>;
      }
      return (
        <a
          key={i}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="chat-link"
          onClick={(event) => {
            event.preventDefault();
            void openHttpsUrl(href);
          }}
        >
          {part}
        </a>
      );
    }
    return <span key={i}>{highlightPlainText(part, self, search, i)}</span>;
  });
}

function highlightPlainText(text: string, self: string, search: string, keyBase: number): ReactNode[] {
  const query = search.trim();
  if (!query) return highlightMention(text, self, keyBase);
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.split(new RegExp(`(${escaped})`, "gi")).flatMap((part, index) => (
    index % 2 === 1
      ? <mark key={`${keyBase}-search-${index}`} className="chat-search-hit">{part}</mark>
      : highlightMention(part, self, keyBase * 1_000 + index)
  ));
}

function highlightMention(text: string, self: string, keyBase: number): ReactNode[] {
  if (!self) return [text];
  // Escaped so a nickname containing regex metacharacters (`[clan]name`) is
  // matched literally; the boundaries mirror `mentions()` in the reducer.
  const escaped = self.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\w[\\]-])(${escaped})(?![\\w[\\]-])`, "gi");
  return text.split(pattern).map((part, i) =>
    i % 2 === 1 ? (
      <mark key={`${keyBase}-${i}`} className="chat-mention">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

export function formatTime(timestamp: string, use24HourTime = true): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: !use24HourTime,
      });
}

/**
 * Whether a message should print its timestamp. The Python client only stamps a
 * line when the clock minute has changed since the previous one, which keeps a
 * fast conversation from turning into a column of identical numbers.
 */
export function showsTime(
  timestamp: string,
  previous: string | undefined,
  use24HourTime = true,
): boolean {
  if (previous === undefined) return true;
  const time = formatTime(timestamp, use24HourTime);
  return time !== "" && time !== formatTime(previous, use24HourTime);
}

/**
 * Strips HTML tags (such as `<a href="...">...</a>`) for plain text consumers
 * like desktop OS notifications.
 */
export function stripHtmlTags(text: string): string {
  if (!text) return "";
  return text
    .replace(/<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi, (_match: string, href: string, inner: string): string => {
      const cleanInner = inner.replace(/<[^>]+>/g, "").trim();
      if (!cleanInner || cleanInner === href) return href;
      return `${cleanInner} (${href})`;
    })
    .replace(/<[^>]+>/g, "");
}

/**
 * Parse text that may contain embedded HTML `<a>` tags (such as server notices)
 * as well as plain URLs, converting them into safe clickable external links.
 */
export function renderFormattedText(text: string): ReactNode[] {
  if (!text) return [];
  const HTML_A_TAG_PATTERN = /<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = HTML_A_TAG_PATTERN.exec(text)) !== null) {
    const [fullMatch, href, innerText] = match;
    const offset = match.index;

    if (offset > lastIndex) {
      const plainSegment = text.slice(lastIndex, offset);
      parts.push(...renderBody(plainSegment, ""));
    }

    let validHref = href;
    try {
      validHref = validateHttpsUrl(href);
    } catch {
      if (!/^https?:\/\//i.test(href)) {
        validHref = "";
      }
    }

    const labelText = innerText.replace(/<[^>]+>/g, "").trim() || href;

    if (validHref) {
      parts.push(
        <a
          key={`html-link-${offset}`}
          href={validHref}
          target="_blank"
          rel="noreferrer noopener"
          className="chat-link"
          onClick={(event) => {
            event.stopPropagation();
            event.preventDefault();
            void openHttpsUrl(validHref);
          }}
        >
          {labelText}
        </a>,
      );
    } else {
      parts.push(<span key={`html-text-${offset}`}>{labelText}</span>);
    }

    lastIndex = offset + fullMatch.length;
  }

  if (lastIndex < text.length) {
    const remainingSegment = text.slice(lastIndex);
    parts.push(...renderBody(remainingSegment, ""));
  }

  return parts;
}
