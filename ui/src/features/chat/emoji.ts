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

/**
 * Names for emoji the picker does not offer but people paste anyway.
 *
 * Hovering an emoji in a message says what it is, and a message can carry any
 * emoji there is, not only the ones this client offers. The full Unicode name
 * database is the thing the note at the top of this file refuses to ship, so
 * this is the middle: the emoji that actually turn up in a game chat, at a
 * couple of kilobytes. An emoji in neither table is still rendered, just
 * without a name to hover.
 */
const EXTRA_EMOJI_NAMES: Readonly<Record<string, string>> = {
  "\u{1F600}": "grinning",
  "\u{1F602}": "joy",
  "\u{1F607}": "halo",
  "\u{1F608}": "imp",
  "\u{1F609}": "wink",
  "\u{1F60B}": "yum",
  "\u{1F60C}": "relieved",
  "\u{1F60F}": "smirk",
  "\u{1F610}": "neutral",
  "\u{1F611}": "expressionless",
  "\u{1F612}": "unamused",
  "\u{1F613}": "cold sweat",
  "\u{1F614}": "pensive",
  "\u{1F616}": "confounded",
  "\u{1F61A}": "kissing",
  "\u{1F61C}": "tongue wink",
  "\u{1F61D}": "tongue out",
  "\u{1F61E}": "disappointed",
  "\u{1F620}": "angry",
  "\u{1F621}": "rage",
  "\u{1F622}": "cry",
  "\u{1F623}": "persevere",
  "\u{1F624}": "triumph",
  "\u{1F625}": "sad but relieved",
  "\u{1F626}": "frowning",
  "\u{1F627}": "anguished",
  "\u{1F628}": "fearful",
  "\u{1F629}": "weary",
  "\u{1F62A}": "sleepy",
  "\u{1F62B}": "tired",
  "\u{1F62C}": "grimace",
  "\u{1F62D}": "sob",
  "\u{1F62F}": "hushed",
  "\u{1F630}": "anxious",
  "\u{1F631}": "scream",
  "\u{1F632}": "astonished",
  "\u{1F633}": "flushed",
  "\u{1F634}": "sleeping",
  "\u{1F635}": "knocked out",
  "\u{1F636}": "no mouth",
  "\u{1F637}": "mask",
  "\u{1F643}": "upside down",
  "\u{1F644}": "eye roll",
  "\u{1F910}": "zipper mouth",
  "\u{1F911}": "money mouth",
  "\u{1F912}": "thermometer face",
  "\u{1F913}": "nerd",
  "\u{1F914}": "thinking",
  "\u{1F915}": "head bandage",
  "\u{1F917}": "hugging",
  "\u{1F920}": "cowboy",
  "\u{1F921}": "clown",
  "\u{1F922}": "nauseated",
  "\u{1F923}": "rofl",
  "\u{1F924}": "drooling",
  "\u{1F925}": "lying",
  "\u{1F928}": "raised eyebrow",
  "\u{1F929}": "star struck",
  "\u{1F92A}": "zany",
  "\u{1F92B}": "shushing",
  "\u{1F92C}": "cursing",
  "\u{1F92D}": "hand over mouth",
  "\u{1F92E}": "vomiting",
  "\u{1F92F}": "mind blown",
  "\u{1F970}": "smiling hearts",
  "\u{1F971}": "yawning",
  "\u{1F973}": "partying",
  "\u{1F974}": "woozy",
  "\u{1F975}": "hot face",
  "\u{1F976}": "cold face",
  "\u{1F97A}": "pleading",
  "\u{1F464}": "person",
  "\u{1F465}": "people",
  "\u{1F46A}": "family",
  "\u{1F46E}": "police officer",
  "\u{1F471}": "blond person",
  "\u{1F474}": "old man",
  "\u{1F475}": "old woman",
  "\u{1F476}": "baby",
  "\u{1F47B}": "ghost",
  "\u{1F47D}": "alien",
  "\u{1F47E}": "space invader",
  "\u{1F480}": "skull",
  "\u{1F482}": "guard",
  "\u{1F4A9}": "poop",
  "\u{1F934}": "prince",
  "\u{1F935}": "person in tuxedo",
  "\u{1F936}": "mrs claus",
  "\u{1F937}": "shrug",
  "\u{1F938}": "cartwheel",
  "\u{1F939}": "juggling",
  "\u{1F93A}": "fencer",
  "\u{1F93C}": "wrestling",
  "\u{1F977}": "ninja",
  "\u{1F978}": "disguised face",
  "\u{1FAE0}": "melting face",
  "\u{1FAE1}": "saluting face",
  "\u{1FAE2}": "face with open eyes and hand over mouth",
  "\u{1FAE3}": "peeking face",
  "\u{1FAE5}": "dotted line face",
  "\u{1FAE6}": "biting lip",
  "\u{1F44A}": "fist bump",
  "\u{1F44C}": "ok hand",
  "\u{1F44D}": "thumbs up",
  "\u{1F44E}": "thumbs down",
  "\u{1F44F}": "clap",
  "\u{1F450}": "open hands",
  "\u{1F4AA}": "muscle",
  "\u{1F590}": "raised hand",
  "\u{1F595}": "middle finger",
  "\u{1F596}": "vulcan salute",
  "\u{1F64B}": "raising hand",
  "\u{1F64C}": "raising hands",
  "\u{1F64D}": "frowning person",
  "\u{1F64E}": "pouting person",
  "\u{1F64F}": "please",
  "\u{1F91A}": "raised back of hand",
  "\u{1F91B}": "left fist",
  "\u{1F91C}": "right fist",
  "\u{1F91D}": "handshake",
  "\u{1F91E}": "fingers crossed",
  "\u{1F91F}": "love you gesture",
  "\u{1F926}": "facepalm",
  "\u{1F927}": "sneezing",
  "\u{1F930}": "pregnant",
  "\u{1F932}": "palms up",
  "\u{1F933}": "selfie",
  "\u{1F9E0}": "brain",
  "\u{1F440}": "eyes",
  "\u{1F441}": "eye",
  "\u{2764}": "heart",
  "\u{1F494}": "broken heart",
  "\u{1F495}": "two hearts",
  "\u{1F49A}": "green heart",
  "\u{1F49B}": "yellow heart",
  "\u{1F499}": "blue heart",
  "\u{1F49C}": "purple heart",
  "\u{1F5A4}": "black heart",
  "\u{1F90D}": "white heart",
  "\u{1F90E}": "brown heart",
  "\u{1F9E1}": "orange heart",
  "\u{1F525}": "fire",
  "\u{1F4A5}": "explosion",
  "\u{1F4A3}": "bomb",
  "\u{1F4A4}": "zzz",
  "\u{1F4AF}": "hundred",
  "\u{1F389}": "party",
  "\u{1F38A}": "confetti",
  "\u{1F381}": "gift",
  "\u{1F3C6}": "trophy",
  "\u{1F947}": "first place",
  "\u{1F948}": "second place",
  "\u{1F949}": "third place",
  "\u{1F396}": "medal",
  "\u{1F3AF}": "target",
  "\u{1F3AE}": "game controller",
  "\u{1F3B2}": "dice",
  "\u{1F3C1}": "chequered flag",
  "\u{1F680}": "rocket",
  "\u{1F6A8}": "siren",
  "\u{1F6D1}": "stop sign",
  "\u{1F916}": "robot",
  "\u{1F6F8}": "ufo",
  "\u{1F30D}": "planet",
  "\u{1F31F}": "glowing star",
  "\u{1F4A1}": "idea",
  "\u{1F4BB}": "laptop",
  "\u{1F4C8}": "chart up",
  "\u{1F4C9}": "chart down",
  "\u{1F4DD}": "memo",
  "\u{1F4E2}": "announcement",
  "\u{1F512}": "locked",
  "\u{1F513}": "unlocked",
  "\u{1F528}": "hammer",
  "\u{1F52B}": "pistol",
  "\u{1F3ED}": "factory",
  "\u{1F6E1}": "shield",
  "\u{2694}": "swords",
  "\u{26A1}": "energy",
  "\u{2B50}": "star",
  "\u{2705}": "check",
  "\u{274C}": "cross",
  "\u{274E}": "cross box",
  "\u{2753}": "question",
  "\u{2754}": "white question",
  "\u{2757}": "exclamation",
  "\u{26A0}": "warning",
  "\u{26D4}": "no entry",
  "\u{2611}": "ballot check",
  "\u{2615}": "coffee",
  "\u{263A}": "smiling",
  "\u{2639}": "frowning",
  "\u{2728}": "sparkles",
  "\u{2744}": "snowflake",
  "\u{2600}": "sun",
  "\u{2601}": "cloud",
  "\u{26C4}": "snowman",
  "\u{26BD}": "football",
  "\u{1F37F}": "popcorn",
  "\u{1F37B}": "beers",
  "\u{1F355}": "pizza",
  "\u{1F41B}": "bug",
  "\u{1F422}": "turtle",
  "\u{1F40C}": "snail",
  "\u{1F419}": "octopus",
  "\u{1F984}": "unicorn",
  "\u{1F42D}": "mouse",
  "\u{1F436}": "dog",
  "\u{1F431}": "cat",
  "\u{1F551}": "clock",
  "\u{23F0}": "alarm clock",
  "\u{23F3}": "hourglass",
  "\u{231B}": "hourglass done",
  "\u{1F3B5}": "music note",
  "\u{1F44B}": "wave",
  "\u{1F451}": "crown",
  "\u{1F48E}": "gem",
  "\u{1F4B0}": "money bag",
  "\u{1F9C0}": "cheese",
  "\u{1F9CA}": "ice",
  "\u{1F9E9}": "puzzle piece",
  "\u{1F52E}": "crystal ball",
};

/** The picker's own names, which win over the table above. */
const PICKER_NAMES: ReadonlyMap<string, string> = new Map(
  ALL_EMOJI.map((item) => [item.char, item.name]),
);

/** Skin-tone modifiers, which never change what an emoji is called here. */
const SKIN_TONE = /[\u{1F3FB}-\u{1F3FF}]/gu;
/** The "draw this as an emoji" selector, which a name lookup ignores. */
const VARIATION_SELECTOR = /\uFE0F/g;

/**
 * What to call an emoji, or `undefined` when this client has no name for it.
 *
 * Tries the character as written, then with the two modifiers that decorate an
 * emoji without changing which one it is stripped off, then the first emoji of
 * a zero-width-joiner sequence, which is the closest honest answer for a
 * compound this client does not know as a whole.
 */
export function emojiName(char: string): string | undefined {
  const candidates = [
    char,
    char.replace(VARIATION_SELECTOR, ""),
    char.replace(SKIN_TONE, "").replace(VARIATION_SELECTOR, ""),
    char.split("\u200D")[0].replace(SKIN_TONE, "").replace(VARIATION_SELECTOR, ""),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const known = PICKER_NAMES.get(candidate) ?? EXTRA_EMOJI_NAMES[candidate];
    if (known) return known;
  }
  return undefined;
}

/**
 * One emoji, with the modifiers and joined parts that belong to it.
 *
 * Narrower than `\p{Extended_Pictographic}` on purpose: that property also
 * covers the copyright and trademark signs, which appear in ordinary prose and
 * are not emoji anybody wants enlarged or labelled. The ranges here are the
 * pictographic blocks proper.
 *
 * Capturing, and only ever used through `String.split`: that keeps what it
 * split on, and it ignores `lastIndex`, which a global regex shared between
 * calls would otherwise carry from one string into the next.
 */
export const EMOJI_PATTERN =
  /([\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{2190}-\u{21FF}\u{231A}-\u{23FF}\u{25A0}-\u{25FF}\u{2934}\u{2935}\u{3030}\u{303D}\u{3297}\u{3299}](?:\uFE0F|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF}|\u{20E3})*(?:\u200D[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}](?:\uFE0F|\u{1F3FB}|\u{1F3FC}|\u{1F3FD}|\u{1F3FE}|\u{1F3FF})*)*)/gu;

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
