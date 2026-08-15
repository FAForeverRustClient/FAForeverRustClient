// The emoji the picker offers, and how a query narrows them.
//
// Deliberately a curated set rather than the full Unicode tables. A complete
// emoji index with names and keywords is well over a megabyte before
// compression, which is more than this client's entire translated catalogue,
// and it would be shipped to every user to make a chat window slightly more
// expressive. What is here is the set people actually reach for in a game
// chat, at a few kilobytes.
//
// Keywords exist because the Unicode name is often not the word anyone types:
// nobody searches "grinning face with smiling eyes", they type "happy" or
// "lol". Searching matches the name and the keywords, never the emoji itself.
//
// The Java client solves the same problem with a bundled `emoticons.json`
// shipped as an asset; keeping it as typed source instead means a typo here is
// a compile error rather than a blank tile at runtime.

import type { MessageKey } from "../../i18n";

export interface EmojiGroup {
  id: string;
  /** Catalogue key for the group heading. */
  label: MessageKey;
  emoji: readonly EmojiEntry[];
}

export interface EmojiEntry {
  /** The character(s) inserted into the message. */
  char: string;
  /** English name, also the accessible label. */
  name: string;
  /** Extra words that should find this emoji. */
  keywords: readonly string[];
}

const entry = (char: string, name: string, ...keywords: string[]): EmojiEntry => ({
  char,
  name,
  keywords,
});

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    id: "faces",
    label: "chat.emoji.group.faces",
    emoji: [
      entry("😀", "grinning", "happy", "smile"),
      entry("😃", "smiley", "happy", "joy"),
      entry("😄", "smile", "happy", "laugh"),
      entry("😁", "grin", "happy"),
      entry("😆", "laughing", "lol", "haha"),
      entry("😅", "sweat smile", "phew", "relief"),
      entry("🤣", "rofl", "lol", "rolling"),
      entry("😂", "joy", "lol", "tears", "crying laughing"),
      entry("🙂", "slight smile", "ok"),
      entry("😉", "wink", "joke"),
      entry("😊", "blush", "happy"),
      entry("😍", "heart eyes", "love"),
      entry("😘", "kiss", "love"),
      entry("😜", "tongue wink", "cheeky"),
      entry("🤔", "thinking", "hmm", "consider"),
      entry("🤨", "raised eyebrow", "doubt", "sceptic"),
      entry("😐", "neutral", "meh"),
      entry("😴", "sleeping", "zzz", "tired"),
      entry("😎", "sunglasses", "cool"),
      entry("🥳", "partying", "celebrate"),
      entry("😏", "smirk", "smug"),
      entry("😒", "unamused", "meh", "annoyed"),
      entry("😞", "disappointed", "sad"),
      entry("😢", "cry", "sad", "tear"),
      entry("😭", "sob", "crying", "sad"),
      entry("😤", "triumph", "angry", "huff"),
      entry("😠", "angry", "mad"),
      entry("😡", "rage", "angry", "mad"),
      entry("🤯", "mind blown", "shocked", "wow"),
      entry("😱", "scream", "shocked", "fear"),
      entry("😬", "grimace", "awkward", "yikes"),
      entry("🙄", "eye roll", "whatever"),
      entry("😳", "flushed", "embarrassed", "oops"),
      entry("🥲", "smiling tear", "bittersweet"),
      entry("🤝", "handshake", "deal", "gg"),
      entry("🫡", "salute", "yes sir", "o7"),
    ],
  },
  {
    id: "gestures",
    label: "chat.emoji.group.gestures",
    emoji: [
      entry("👍", "thumbs up", "yes", "ok", "agree", "+1"),
      entry("👎", "thumbs down", "no", "disagree", "-1"),
      entry("👏", "clap", "applause", "well played"),
      entry("🙏", "please", "thanks", "pray"),
      entry("🤦", "facepalm", "oh no"),
      entry("🤷", "shrug", "dunno", "idk"),
      entry("✌️", "victory", "peace"),
      entry("🤞", "fingers crossed", "hope", "luck"),
      entry("👋", "wave", "hello", "bye", "hi"),
      entry("💪", "muscle", "strong"),
      entry("🫠", "melting", "done", "gone"),
      entry("👀", "eyes", "look", "watching"),
    ],
  },
  {
    id: "game",
    label: "chat.emoji.group.game",
    emoji: [
      entry("🎮", "game controller", "play", "gaming"),
      entry("⚔️", "swords", "battle", "fight", "war"),
      entry("🛡️", "shield", "defend", "defense"),
      entry("💥", "explosion", "boom", "nuke"),
      entry("🚀", "rocket", "launch", "fast"),
      entry("🛸", "ufo", "aeon", "alien"),
      entry("🤖", "robot", "cybran", "bot", "ai"),
      entry("🏭", "factory", "build", "eco"),
      entry("⚡", "energy", "power", "fast"),
      entry("🔥", "fire", "hot", "burn"),
      entry("💀", "skull", "dead", "rip"),
      entry("🏆", "trophy", "win", "victory", "tournament"),
      entry("🥇", "first place", "gold", "win"),
      entry("🎯", "target", "aim", "hit"),
      entry("🧠", "brain", "smart", "big brain"),
      entry("🐢", "turtle", "slow", "turtling"),
      entry("🌍", "planet", "map", "world"),
      entry("⭐", "star", "favourite", "rating"),
    ],
  },
  {
    id: "symbols",
    label: "chat.emoji.group.symbols",
    emoji: [
      entry("❤️", "heart", "love"),
      entry("💔", "broken heart", "sad"),
      entry("✅", "check", "yes", "done", "ok"),
      entry("❌", "cross", "no", "wrong", "fail"),
      entry("❓", "question", "what", "help"),
      entry("❗", "exclamation", "important", "warning"),
      entry("⚠️", "warning", "careful", "caution"),
      entry("🎉", "party", "celebrate", "congrats"),
      entry("👑", "crown", "king", "best"),
      entry("🍿", "popcorn", "watching", "drama", "spectate"),
      entry("☕", "coffee", "afk", "break"),
      entry("🕐", "clock", "wait", "time", "soon"),
    ],
  },
] as const;

/** Every emoji, in group order. What an empty query shows. */
export const ALL_EMOJI: readonly EmojiEntry[] = EMOJI_GROUPS.flatMap((group) => group.emoji);

/** Tiles per row. The CSS grid and the arrow-key step must agree on this. */
export const EMOJI_COLUMNS = 8;

/**
 * Where the selection lands after an arrow key.
 *
 * Extracted from the picker because this is where the off-by-ones live: a
 * vertical step near either end must clamp rather than wrap or escape the
 * list, and the list shrinks under the selection whenever the query narrows.
 * Returns `0` for an empty list so a caller never indexes into nothing.
 */
export function stepSelection(current: number, key: string, total: number): number {
  if (total <= 0) return 0;
  const step = {
    ArrowRight: 1,
    ArrowLeft: -1,
    ArrowDown: EMOJI_COLUMNS,
    ArrowUp: -EMOJI_COLUMNS,
  }[key];
  if (step === undefined) return Math.min(Math.max(current, 0), total - 1);
  return Math.min(Math.max(current + step, 0), total - 1);
}

/** The flat index each group starts at in the unfiltered list. */
export function groupOffsets(groups = EMOJI_GROUPS): number[] {
  const offsets: number[] = [];
  let running = 0;
  for (const group of groups) {
    offsets.push(running);
    running += group.emoji.length;
  }
  return offsets;
}

/**
 * Emoji matching `query`, best first.
 *
 * A name that *starts* with the query outranks one that merely contains it, so
 * typing "win" offers "win"-prefixed entries before "mind blown". Matching is
 * case-insensitive and ignores surrounding whitespace; an empty query matches
 * everything, which is what the picker shows before anyone types.
 */
export function searchEmoji(query: string, groups = EMOJI_GROUPS): EmojiEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return groups.flatMap((group) => group.emoji);

  const scored: Array<{ entry: EmojiEntry; rank: number }> = [];
  for (const group of groups) {
    for (const item of group.emoji) {
      const terms = [item.name, ...item.keywords];
      let rank = Number.POSITIVE_INFINITY;
      for (const term of terms) {
        const lowered = term.toLowerCase();
        if (lowered.startsWith(needle)) rank = Math.min(rank, 0);
        else if (lowered.includes(needle)) rank = Math.min(rank, 1);
      }
      if (Number.isFinite(rank)) scored.push({ entry: item, rank });
    }
  }

  // Stable within a rank: the curated order inside each group is deliberate.
  return scored
    .map((hit, index) => ({ ...hit, index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((hit) => hit.entry);
}
