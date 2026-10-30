// How the tournament chat completes mentions, by the website's own rules
// (`updateMentions` in its `app.results.js`), and how its posts become lines
// of the Chat tab's log.
//
// Presentation only. The service resolves `@name` itself when a post arrives,
// and pings whoever it matches; nothing here decides who is pinged.

import type { ChatMessage, ChatPost, ChatUser, Tourney } from "../../../ipc/bindings";

export interface MentionQuery {
  /** Where the `@` is. */
  start: number;
  /** What has been typed after it, lowercased. */
  query: string;
}

/**
 * The `@word` being typed at the caret, or null.
 *
 * The last `@` before the caret, at the start or after a space, with no space
 * between it and the caret.
 */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start < 0) return null;
  if (start > 0 && !/\s/.test(before[start - 1])) return null;
  const typed = before.slice(start + 1);
  if (/\s/.test(typed)) return null;
  return { start, query: typed.toLowerCase() };
}

/**
 * Who can be mentioned, filtered by what was typed: `everyone` for an
 * organiser, then every entrant, then every team name. A substring match, the
 * first eight, as on the website.
 */
export function mentionCandidates(event: Tourney, query: string): string[] {
  const names = new Map<string, string>();
  const add = (name: string) => {
    const trimmed = name.trim();
    if (trimmed !== "" && !names.has(trimmed.toLowerCase())) names.set(trimmed.toLowerCase(), trimmed);
  };
  if (event.viewer.organiser) add("everyone");
  for (const player of event.players) add(player.name);
  for (const team of event.teams) add(team.name);
  return [...names.entries()]
    .filter(([key]) => key.includes(query))
    .slice(0, 8)
    .map(([, name]) => name);
}

/** The draft with the `@word` at `mention` replaced by `@name `, and where the caret goes. */
export function applyMention(
  text: string,
  caret: number,
  mention: MentionQuery,
  name: string,
): { text: string; caret: number } {
  const inserted = `@${name} `;
  return {
    text: text.slice(0, mention.start) + inserted + text.slice(caret),
    caret: mention.start + inserted.length,
  };
}

/**
 * A post as a line of the Chat tab's log, which draws the room (`MessageList`).
 *
 * The service's announcements (dice rolls, organiser pings) are the log's info
 * lines: nobody's name, nothing to answer. The post's own id is the line's
 * `msgid`, which is what a reply and the line's toolbar are keyed on.
 */
export function postMessage(post: ChatPost): ChatMessage {
  return {
    id: post.id,
    sender: post.system ? "" : post.author,
    content: post.body,
    timestamp: post.at === null ? "" : new Date(post.at * 1000).toISOString(),
    kind: post.system ? "info" : "message",
    msgid: post.id,
    replyTo: post.replyTo?.id ?? "",
  };
}

/**
 * What each reply in a room quotes, by the quoted post's id, for the log's
 * quote line. The service's snapshot rather than the post itself, so a quote
 * survives the original being deleted or scrolled out of what was loaded.
 */
export function quotedPosts(posts: ChatPost[]): Map<string, ChatMessage> {
  const quotes = new Map<string, ChatMessage>();
  for (const post of posts) {
    if (post.replyTo === null) continue;
    quotes.set(post.replyTo.id, {
      id: post.replyTo.id,
      sender: post.replyTo.author,
      content: post.replyTo.body,
      timestamp: "",
      kind: "message",
      msgid: post.replyTo.id,
    });
  }
  return quotes;
}

/**
 * Everyone who may write in the event's rooms, as the log's roster: what it
 * colours names by and which names a line can ping. The organisers carry an
 * operator's mark, so the reader's moderator colour picks them out as it does
 * a channel's moderators on the Chat tab.
 */
export function roomUsers(event: Tourney): ChatUser[] {
  const users = new Map<string, ChatUser>();
  for (const name of event.organisers) users.set(name.toLowerCase(), { name, elevation: "@" });
  for (const player of event.players) {
    const key = player.name.toLowerCase();
    if (!users.has(key)) users.set(key, { name: player.name, elevation: "" });
  }
  return [...users.values()];
}
