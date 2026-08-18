import type { CSSProperties } from "react";
import type { ChatNameColors, ChatPreferences, SocialState } from "../ipc/bindings";

export type CategoryColorKey = Exclude<keyof ChatNameColors, "players">;

// CSS custom properties cannot be used as the value of an HTML color input.
export const DEFAULT_COLOR_PICKER_VALUE = "#808080";

export const STANDARD_CATEGORY_COLORS: Record<CategoryColorKey, string> = {
  selfColor: "#ffdd00",
  friends: "#87cefa",
  foes: "#dc143c",
  moderators: "#32cd32",
  admins: "#ba55d3",
};

/**
 * A stable hue per nickname, spread with the golden-ratio conjugate so nearby
 * names don't land on nearby colours. This is the same trick the Java client's
 * `ColorGeneratorUtil` uses; saturation and lightness stay in tokens.css or inline
 * HSL for readability across dark and light themes.
 */
export function nickHue(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const golden = 0.618033988749895;
  return Math.round((((hash / 0xffffffff) + golden) % 1) * 360);
}

/** Inline style carrying the generated hue for player nicknames to consume. */
export const nickStyle = (name: string): CSSProperties =>
  ({ "--nick-hue": `${nickHue(name)}`, color: `hsl(${nickHue(name)}, 75%, 65%)` }) as CSSProperties;

/**
 * Case-insensitive key for nickname matching.
 *
 * This replaces `localeCompare(other, undefined, { sensitivity: "accent" })`,
 * which was the single most expensive thing in the chat tab. Passing an options
 * object defeats `localeCompare`'s fast path and constructs a fresh
 * `Intl.Collator` on **every call**, and these comparisons ran once per
 * assigned colour, per rendered nickname, per re-render. Measured on a roster
 * of 1000 plus 500 messages with 20 assigned colours: 608 ms per re-render,
 * against 0.13 ms for the lookups below.
 *
 * `toLowerCase()` keeps the same practical semantics: case-insensitive and
 * accent-preserving. It uses Unicode default case mapping rather than locale
 * collation, so a locale-specific pair like Turkish dotted/dotless I would
 * compare differently. That matches what the backend already does
 * (`eq_ignore_ascii_case` on logins) and does not arise for IRC nicknames.
 */
export function nickKey(name: string): string {
  return name.toLowerCase();
}

// Derived lookups are cached against the identity of the source object. The
// frontend reducer replaces only the slice an event touched, so these stay
// referentially stable until the colours or the friend/foe lists actually
// change, and the cache is rebuilt exactly once when they do.
const PLAYER_COLOR_CACHE = new WeakMap<object, Map<string, string>>();
const NAME_SET_CACHE = new WeakMap<object, Set<string>>();

/** Assigned per-player colours, keyed for O(1) case-insensitive lookup. */
export function playerColorLookup(players: Record<string, string>): Map<string, string> {
  let lookup = PLAYER_COLOR_CACHE.get(players);
  if (!lookup) {
    lookup = new Map();
    for (const [player, color] of Object.entries(players)) lookup.set(nickKey(player), color);
    PLAYER_COLOR_CACHE.set(players, lookup);
  }
  return lookup;
}

function nameSet(names: string[]): Set<string> {
  let set = NAME_SET_CACHE.get(names);
  if (!set) {
    set = new Set(names.map(nickKey));
    NAME_SET_CACHE.set(names, set);
  }
  return set;
}

export function includesName(names: string[], name: string): boolean {
  return nameSet(names).has(nickKey(name));
}

/** The colour assigned to this exact nickname, if the user set one. */
export function assignedPlayerColor(
  players: Record<string, string>,
  name: string,
): string | undefined {
  return playerColorLookup(players).get(nickKey(name));
}

/**
 * Resolve player nickname color based on user assignments in chat/settings:
 * 1. Specific custom assigned player color (`nameColors.players[name]`)
 * 2. Friends category color (`nameColors.friends`) if the player is in `social.friends`
 * 3. Foes category color (`nameColors.foes`) if the player is in `social.foes`
 * 4. Deterministic colored name hue if `coloredNames` preference is enabled
 */
export function resolvePlayerStyle(
  name: string,
  social: SocialState,
  preferences: ChatPreferences,
  selfName?: string,
): CSSProperties | undefined {
  if (!name) return undefined;

  const assignedColor = assignedPlayerColor(preferences.nameColors.players, name);
  if (assignedColor) return { color: assignedColor };

  if (selfName && name.toLowerCase() === selfName.toLowerCase() && preferences.nameColors.selfColor) {
    return { color: preferences.nameColors.selfColor };
  }

  if (includesName(social.friends, name) && preferences.nameColors.friends) {
    return { color: preferences.nameColors.friends };
  }

  if (includesName(social.foes, name) && preferences.nameColors.foes) {
    return { color: preferences.nameColors.foes };
  }

  if (preferences.coloredNames) {
    return nickStyle(name);
  }

  return undefined;
}
