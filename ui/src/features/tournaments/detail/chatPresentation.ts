// How the tournament chat reads and completes mentions: the website's own
// rules (`highlightMentions`, `updateMentions` in its `app.results.js`).
//
// Presentation only. The service resolves `@name` itself when a post arrives,
// and pings whoever it matches; nothing here decides who is pinged.

import type { Tourney } from "../../../ipc/bindings";

/** The website's mention pattern: `@` at the start or after a space, up to 40 non-space characters. */
const MENTION = /(^|\s)@([^\s@]{1,40})/g;

export type ChatSpan = { kind: "text"; text: string } | { kind: "mention"; text: string };

/** A post's text split into plain runs and `@mentions`, for highlighting. */
export function mentionSpans(text: string): ChatSpan[] {
  const spans: ChatSpan[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const at = (match.index ?? 0) + match[1].length;
    if (at > last) spans.push({ kind: "text", text: text.slice(last, at) });
    spans.push({ kind: "mention", text: `@${match[2]}` });
    last = at + 1 + match[2].length;
  }
  if (last < text.length) spans.push({ kind: "text", text: text.slice(last) });
  return spans;
}

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
 * How long a pause still keeps two posts from one person in one block: the
 * Chat tab's window (`continuesPrevious`), so a run reads the same in both.
 */
const CONTINUATION_SECONDS = 5 * 60;

/** The fields of a post the row layout decides on. */
export interface PostShape {
  author: string;
  at: number | null;
  system: boolean;
  replyTo: unknown;
}

/**
 * Whether a post continues the one above it, and so carries no name or
 * avatar of its own. The Chat tab's rule: the same person, a few minutes
 * apart, and neither an announcement nor a reply, which needs a name above
 * its quote to make sense.
 */
export function postContinues(post: PostShape, previous: PostShape | undefined): boolean {
  if (previous === undefined) return false;
  if (post.system || previous.system) return false;
  if (post.replyTo !== null) return false;
  if (post.author !== previous.author) return false;
  if (post.at === null || previous.at === null) return false;
  const gap = post.at - previous.at;
  return gap >= 0 && gap <= CONTINUATION_SECONDS;
}

/**
 * A post's clock time as the Chat tab prints it, honouring the same 24-hour
 * setting. Empty for a post without a time.
 */
export function postClock(at: number | null, use24HourTime: boolean): string {
  if (at === null) return "";
  const date = new Date(at * 1000);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: !use24HourTime });
}

/**
 * Whether a post prints its time: only when the minute changed since the post
 * above, as in the Chat tab, so a quick exchange is not a column of the same
 * number.
 */
export function postShowsTime(
  post: PostShape,
  previous: PostShape | undefined,
  use24HourTime: boolean,
): boolean {
  const clock = postClock(post.at, use24HourTime);
  if (clock === "") return false;
  return previous === undefined || clock !== postClock(previous.at, use24HourTime);
}
