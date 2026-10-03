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
