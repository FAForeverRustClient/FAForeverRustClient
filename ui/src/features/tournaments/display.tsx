// How this viewer wants the tournament drawn, on their own screen only.
//
// The website's three header switches: "View as player" (an organiser browses
// without their tools), "Show players" (a team's players instead of its name
// in the bracket and the match lists) and "Streamer mode" (results hidden for
// an on-stream reveal, one match at a time). None of them is ever sent to the
// service; each is kept in this machine's storage, as the website keeps them
// in the browser's, and each has a keyboard shortcut.

import { createContext, useCallback, useContext, useState } from "react";
import type { MessageKey } from "../../i18n";
import type { Tourney, TourneyMatch } from "../../ipc/bindings";
import { loadStoredSet, saveStoredSet } from "../../shared/storage";

export interface TourneyDisplay {
  showPlayers: boolean;
  streamer: boolean;
  /** Whether this match's result is hidden right now. */
  masked: (entry: TourneyMatch) => boolean;
  /** Reveal one hidden result, or hide it again. */
  toggleReveal: (matchId: string) => void;
}

const PLAIN: TourneyDisplay = {
  showPlayers: false,
  streamer: false,
  masked: () => false,
  toggleReveal: () => undefined,
};

export const TourneyDisplayContext = createContext<TourneyDisplay>(PLAIN);

export function useTourneyDisplay(): TourneyDisplay {
  return useContext(TourneyDisplayContext);
}

/** A result streamer mode hides: a finished match not revealed yet. */
export function isMasked(streamer: boolean, revealed: Set<string>, entry: TourneyMatch): boolean {
  return streamer && entry.status === "done" && !revealed.has(entry.id);
}

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    window.localStorage.setItem(key, on ? "1" : "0");
  } catch {
    // The switch still works for this session.
  }
}

/** A switch kept in storage under the website's own key. */
export function useStoredFlag(key: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => readFlag(key));
  const set = useCallback(
    (next: boolean) => {
      writeFlag(key, next);
      setOn(next);
    },
    [key],
  );
  return [on, set];
}

const isString = (value: unknown): value is string => typeof value === "string";

/** The results revealed during streamer mode, per tournament (`faf_reveal_{id}`). */
export function useRevealed(tournamentId: string): [Set<string>, (matchId: string) => void] {
  const key = `faf_reveal_${tournamentId}`;
  // Held with the key it was read for: opening another tournament reads that
  // one's set on the spot rather than showing the last one's for a render.
  const [held, setHeld] = useState(() => ({ key, set: loadStoredSet(key, isString) }));
  const revealed = held.key === key ? held.set : loadStoredSet(key, isString);
  const toggle = useCallback(
    (matchId: string) => {
      setHeld((previous) => {
        const next = new Set(previous.key === key ? previous.set : loadStoredSet(key, isString));
        if (next.has(matchId)) next.delete(matchId);
        else next.add(matchId);
        saveStoredSet(key, next);
        return { key, set: next };
      });
    },
    [key],
  );
  return [revealed, toggle];
}

/**
 * A team as its players, joined, the way "Show players" draws it: the
 * website's `bracketLabel`. `null` where the team has nobody, which falls back
 * to its name.
 */
export function playersLabel(event: Tourney, teamId: string | null): string | null {
  const team = event.teams.find((held) => held.id === teamId);
  if (team === undefined) return null;
  const names = team.playerIds
    .map((id) => event.players.find((player) => player.id === id)?.name ?? "")
    .filter((name) => name !== "");
  return names.length === 0 ? null : names.join(", ");
}

export type HotkeyAction = "players" | "streamer" | "playerView";

export const HOTKEY_ACTIONS: { id: HotkeyAction; label: MessageKey; note?: MessageKey }[] = [
  { id: "players", label: "tournaments.display.hotkeyPlayers" },
  { id: "streamer", label: "tournaments.display.hotkeyStreamer" },
  { id: "playerView", label: "tournaments.display.hotkeyPlayerView", note: "tournaments.display.needsOrganiser" },
];

const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = { players: "f", streamer: "s", playerView: "v" };
const HOTKEYS_KEY = "faf_hotkeys";

/** The shortcuts, the saved ones over the defaults; `""` is switched off. */
export function loadHotkeys(): Record<HotkeyAction, string> {
  try {
    const raw = window.localStorage.getItem(HOTKEYS_KEY);
    const saved: unknown = raw === null ? {} : JSON.parse(raw);
    const merged = { ...DEFAULT_HOTKEYS };
    if (saved !== null && typeof saved === "object") {
      for (const action of HOTKEY_ACTIONS) {
        const value = (saved as Record<string, unknown>)[action.id === "playerView" ? "playerview" : action.id];
        if (typeof value === "string") merged[action.id] = value.toLowerCase();
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_HOTKEYS };
  }
}

/** Stored under the website's action names, so its own settings read the same. */
export function saveHotkeys(keys: Record<HotkeyAction, string>): void {
  try {
    window.localStorage.setItem(
      HOTKEYS_KEY,
      JSON.stringify({ players: keys.players, streamer: keys.streamer, playerview: keys.playerView }),
    );
  } catch {
    // Kept for this session only.
  }
}

/** Bind `key` to `action`, taking it off whichever action had it. */
export function rebind(
  keys: Record<HotkeyAction, string>,
  action: HotkeyAction,
  key: string,
): Record<HotkeyAction, string> {
  const next = { ...keys };
  for (const other of HOTKEY_ACTIONS) if (other.id !== action && next[other.id] === key) next[other.id] = "";
  next[action] = key;
  return next;
}

/** The action a key press means, if any: letters and digits, no modifiers. */
export function hotkeyAction(keys: Record<HotkeyAction, string>, pressed: string): HotkeyAction | null {
  const key = pressed.toLowerCase();
  if (!/^[a-z0-9]$/.test(key)) return null;
  return HOTKEY_ACTIONS.find((action) => keys[action.id] === key)?.id ?? null;
}
